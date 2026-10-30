import { Body, Controller, Get, Injectable, Param, Put, Query } from '@nestjs/common';
import { assertInBranch, branchesFor, EntitlementsClient, RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { conflict, CurrentActor, DomainError, notFound, parse } from '@mc/nest-common';
import { type Actor, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { AuditClient } from './audit.client.js';
import { RecordAccess } from './access.js';
import { Vitals } from './vitals.js';

export const VITALS = 'vitals:record:branch';
const PRIORITIES = ['ROUTINE', 'URGENT', 'EMERGENCY'] as const;
const Triage = z.object({
  vitals: Vitals.default({}),
  priority: z.enum(PRIORITIES).default('ROUTINE'),
  chiefComplaint: z.string().trim().max(500).nullable().default(null),
  version: z.number().int().optional(),
}).refine((t) => Object.keys(t.vitals).length > 0 || !!t.chiefComplaint, 'record at least one vital sign or the complaint');
const Uuid = z.uuid();
const id = (v: string) => { if (!Uuid.safeParse(v ?? '').success) throw notFound('appointment'); return v; };

/**
 * Nurse triage (docs/ROLE-FLOWS-AND-GAPS.md, nurse): vitals, how urgent, and the complaint, recorded after check-in and
 * before the doctor calls the patient in. The doctor sees the priority in the queue; the vitals and complaint are
 * copied into the visit note when the doctor opens it.
 */
@Injectable()
export class TriageService {
  constructor(private readonly db: TenantDbRouter, private readonly crypto: FieldCrypto, private readonly audit: AuditClient, private readonly access: RecordAccess, private readonly entitlements: EntitlementsClient) {}

  private caps(actor: Actor) { return this.entitlements.capabilities(TenantContext.require().id, actor); }

  private async dto(r: any) {
    return {
      appointmentId: r.appointment_id, patientId: r.patient_id, priority: r.priority, vitals: r.vitals ?? {},
      chiefComplaint: await this.crypto.decrypt(TenantContext.require().id, `triage.complaint:${r.appointment_id}`, r.complaint_enc),
      recordedBy: r.recorded_by_name, recordedAt: r.recorded_at, version: r.version,
    };
  }

  /** The nurse at the appointment's branch, or the appointment's doctor. */
  private async assertCanSee(c: Queryable, actor: Actor, a: { doctor_id: string; branch_id: string }) {
    const doctor = await this.access.doctorOf(c, actor);
    if (doctor?.id === a.doctor_id) return doctor.name;
    assertInBranch(await this.caps(actor), VITALS, a.branch_id, 'appointment');
    return actor.email ?? null;
  }

  async record(actor: Actor, appointmentId: string, v: z.infer<typeof Triage>) {
    const caps = await this.caps(actor);
    return this.db.tx(async (c) => {
      const { rows: [a] } = await c.query('SELECT * FROM care_appointments WHERE appointment_id = $1', [appointmentId]);
      if (!a) throw new DomainError(404, 'NOT_FOUND', 'appointment not found (if the patient was checked in a moment ago, try again)');
      assertInBranch(caps, VITALS, a.branch_id, 'appointment');
      // the doctor's note is open (its event may not have reached us yet): vitals go in the note now
      const { rowCount: started } = await c.query('SELECT 1 FROM encounters WHERE appointment_id = $1', [appointmentId]);
      if (started) throw conflict('INVALID_STATE_TRANSITION', 'the doctor has started the visit: they record vitals in the note now');
      if (a.status === 'CONFIRMED') throw new DomainError(422, 'PATIENT_NOT_HERE', 'check the patient in first');
      if (a.status !== 'CHECKED_IN') throw conflict('INVALID_STATE_TRANSITION', a.status === 'IN_PROGRESS' ? 'the doctor has started the visit: they record vitals in the note now' : `the appointment is ${String(a.status).toLowerCase().replace('_', ' ')}`);
      const { rows: [cur] } = await c.query('SELECT version FROM triage WHERE appointment_id = $1 FOR UPDATE', [appointmentId]);
      if (cur && v.version !== undefined && v.version !== cur.version) throw conflict('VERSION_CONFLICT', 'someone else just updated the triage; reload and try again');
      const complaint = await this.crypto.encrypt(TenantContext.require().id, `triage.complaint:${appointmentId}`, v.chiefComplaint);
      const { rows: [r] } = await c.query(
        `INSERT INTO triage (appointment_id, patient_id, branch_id, doctor_id, vitals, priority, complaint_enc, recorded_by, recorded_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (appointment_id) DO UPDATE SET vitals = $5, priority = $6, complaint_enc = $7, recorded_by = $8, recorded_by_name = $9, recorded_at = now(), version = triage.version + 1
         RETURNING *`,
        [appointmentId, a.patient_id, a.branch_id, a.doctor_id, JSON.stringify(v.vitals), v.priority, complaint, actor.id, actor.email ?? null]);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: actor.email ?? null, action: cur ? 'UPDATE' : 'CREATE', resourceType: 'TRIAGE', resourceId: appointmentId, patientId: a.patient_id, purpose: 'TREATMENT', changes: ['priority', ...Object.keys(v.vitals), ...(v.chiefComplaint ? ['chiefComplaint'] : [])] });
      return this.dto(r);
    });
  }

  async get(actor: Actor, appointmentId: string) {
    const c = await this.db.current();
    const { rows: [r] } = await c.query('SELECT * FROM triage WHERE appointment_id = $1', [appointmentId]);
    const { rows: [a] } = await c.query('SELECT * FROM care_appointments WHERE appointment_id = $1', [appointmentId]);
    if (!a) throw notFound('appointment');
    const name = await this.assertCanSee(c, actor, a);
    if (!r) return null;
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: name, action: 'READ', resourceType: 'TRIAGE', resourceId: appointmentId, patientId: r.patient_id, purpose: 'TREATMENT' });
    return this.dto(r);
  }

  /**
   * For queue screens: which appointments have been triaged and how urgent (no clinical values, so not audited). The
   * doctor gets their own appointments; nurses those at their branches.
   */
  async summary(actor: Actor, appointmentIds: string[]) {
    if (!appointmentIds.length) return {};
    const c = await this.db.current();
    const doctor = await this.access.doctorOf(c, actor);
    const scope = branchesFor(await this.caps(actor), VITALS);
    const { rows } = await c.query(
      `SELECT appointment_id, priority, recorded_at FROM triage WHERE appointment_id = ANY($1)
         AND (doctor_id = $2 OR ($3::boolean AND ($4::uuid[] IS NULL OR branch_id = ANY($4))))`,
      [appointmentIds, doctor?.id ?? null, scope === null || scope.length > 0, scope]);
    return Object.fromEntries(rows.map((r) => [r.appointment_id, { priority: r.priority, recordedAt: r.recorded_at }]));
  }

  /** The doctor opens the note: the triage's vitals and complaint become the note's starting point. */
  async copyIntoEncounter(c: Queryable, appointmentId: string, encounterId: string) {
    const { rows: [r] } = await c.query('SELECT * FROM triage WHERE appointment_id = $1', [appointmentId]);
    if (!r) return false;
    const t = TenantContext.require().id;
    const complaint = await this.crypto.decrypt(t, `triage.complaint:${appointmentId}`, r.complaint_enc);
    await c.query('UPDATE encounters SET vitals = $2, complaint_enc = $3 WHERE id = $1', [encounterId, JSON.stringify(r.vitals ?? {}), complaint ? await this.crypto.encrypt(t, `encounters.complaint:${encounterId}`, complaint) : null]);
    return true;
  }
}

@Controller('v1')
@RequireModule('emr')
export class TriageController {
  constructor(private readonly triage: TriageService) {}

  @Put('appointments/:appointmentId/triage')
  @RequirePermission(VITALS)
  record(@Param('appointmentId') a: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.triage.record(actor, id(a), parse(Triage, body));
  }

  /** The nurse who recorded it (and colleagues at the branch), or the appointment's doctor. null = not triaged yet. */
  @Get('appointments/:appointmentId/triage')
  async get(@Param('appointmentId') a: string, @CurrentActor() actor: Actor) {
    return { triage: await this.triage.get(actor, id(a)) };
  }

  @Get('triage-summary')
  summary(@Query('appointmentIds') ids: string | undefined, @CurrentActor() actor: Actor) {
    const list = (ids ?? '').split(',').filter((x) => Uuid.safeParse(x).success).slice(0, 200);
    return this.triage.summary(actor, list);
  }
}
