import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ConsentScope, EventTypes, Topics } from '@mc/contracts';
import { CurrentActor, DomainError, forbidden, notFound, parse } from '@mc/nest-common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditClient } from './audit.client.js';

const Uuid = z.uuid();
const id = (v: string, what: string) => { if (!Uuid.safeParse(v ?? '').success) throw notFound(what); return v; };
const NewAllergy = z.object({ substance: z.string().trim().min(2).max(100), severity: z.enum(['MILD', 'MODERATE', 'SEVERE', 'UNKNOWN']).default('UNKNOWN'), reaction: z.string().trim().max(200).nullable().default(null) });
const NewConsent = z.object({ patientId: z.uuid(), doctorId: z.uuid(), scope: z.array(ConsentScope).min(1).max(3), days: z.number().int().min(1).max(365) });

const toAllergy = (r: any) => ({ id: r.id, substance: r.substance, severity: r.severity, reaction: r.reaction, recordedBy: { kind: r.recorded_by_kind, name: r.recorded_by_name }, createdAt: r.created_at });
const toConsent = (r: any) => ({ id: r.id, patientId: r.patient_id, doctor: { id: r.grantee_id, name: r.grantee_name }, scope: r.scope, validFrom: r.valid_from, validUntil: r.valid_until, revokedAt: r.revoked_at, active: !r.revoked_at && new Date(r.valid_until) > new Date() });

/** Is this person the account holder (or guardian) of the patient? */
async function ownPatient(c: Queryable, actor: Actor, patientId: string) {
  if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'patients only');
  const { rows } = await c.query('SELECT id, full_name FROM patients WHERE id = $1 AND account_person_id = $2', [patientId, actor.id]);
  if (!rows[0]) throw notFound('patient');
  return rows[0];
}

/** records-service decides who treats whom (one policy for the whole clinical record). */
async function careAccess(tenantId: string, userId: string, patientId: string): Promise<{ allowed: boolean; purpose: string; doctorName: string | null }> {
  const res = await fetch(`${process.env.SVC_URL_RECORDS ?? 'http://localhost:4410'}/internal/tenants/${tenantId}/care-access?userId=${userId}&patientId=${patientId}&scope=NOTES`, {
    headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!res?.ok) throw new DomainError(502, 'RECORDS_UNAVAILABLE', 'could not check access');
  return (await res.json()) as { allowed: boolean; purpose: string; doctorName: string | null };
}

/** Patients: their own and family members' allergies and record sharing. */
@Controller('v1/me')
export class MyClinicalController {
  constructor(private readonly db: TenantDbRouter) {}

  @Get('patients/:patientId/allergies')
  @RequirePermission('profile:manage:own')
  async allergies(@Param('patientId') p: string, @CurrentActor() actor: Actor) {
    await ownPatient(await this.db.current(), actor, id(p, 'patient'));
    const { rows } = await this.db.query('SELECT * FROM allergies WHERE patient_id = $1 AND removed_at IS NULL ORDER BY created_at', [p]);
    return rows.map(toAllergy);
  }

  @Post('patients/:patientId/allergies')
  @RequirePermission('profile:manage:own')
  async addAllergy(@Param('patientId') p: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const a = parse(NewAllergy, body);
    return this.db.tx(async (c) => {
      await ownPatient(c, actor, id(p, 'patient'));
      return insertAllergy(c, p, a, actor, null);
    });
  }

  @Delete('patients/:patientId/allergies/:allergyId')
  @RequirePermission('profile:manage:own')
  @HttpCode(204)
  async removeAllergy(@Param('patientId') p: string, @Param('allergyId') a: string, @CurrentActor() actor: Actor) {
    await ownPatient(await this.db.current(), actor, id(p, 'patient'));
    const { rowCount } = await this.db.query('UPDATE allergies SET removed_at = now() WHERE id = $1 AND patient_id = $2 AND removed_at IS NULL', [id(a, 'allergy'), p]);
    if (!rowCount) throw notFound('allergy');
  }

  @Get('consents')
  @RequirePermission('profile:manage:own')
  async consents(@Query('patientId') p: string, @CurrentActor() actor: Actor) {
    await ownPatient(await this.db.current(), actor, id(p, 'patient'));
    const { rows } = await this.db.query('SELECT * FROM consents WHERE patient_id = $1 ORDER BY valid_from DESC LIMIT 100', [p]);
    return rows.map(toConsent);
  }

  @Post('consents')
  @RequirePermission('profile:manage:own')
  async grant(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const v = parse(NewConsent, body);
    const t = TenantContext.require();
    // the doctor must be a published doctor of this hospital (name comes from the directory, not the client)
    const res = await fetch(`${process.env.SVC_URL_PROVIDER ?? 'http://localhost:4404'}/v1/public/doctors/${v.doctorId}`, { headers: { 'x-tenant-host': t.hosts[0] } }).catch(() => null);
    if (!res?.ok) throw notFound('doctor');
    const doctor = (await res.json()) as { id: string; name: string };
    return this.db.tx(async (c) => {
      await ownPatient(c, actor, v.patientId);
      const { rows: [r] } = await c.query(
        `INSERT INTO consents (id, patient_id, grantee_id, grantee_name, scope, valid_until, granted_by) VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6), $7) RETURNING *`,
        [randomUUID(), v.patientId, doctor.id, doctor.name, v.scope, v.days, actor.id]);
      await announce(c, r, EventTypes.consentGranted);
      return toConsent(r);
    });
  }

  @Delete('consents/:consentId')
  @RequirePermission('profile:manage:own')
  @HttpCode(204)
  async revoke(@Param('consentId') cid: string, @CurrentActor() actor: Actor) {
    await this.db.tx(async (c) => {
      const { rows } = await c.query(`SELECT c.* FROM consents c JOIN patients p ON p.id = c.patient_id WHERE c.id = $1 AND p.account_person_id = $2 FOR UPDATE`, [id(cid, 'consent'), actor.id]);
      if (!rows[0]) throw notFound('consent');
      if (rows[0].revoked_at) return;
      const { rows: [r] } = await c.query('UPDATE consents SET revoked_at = now() WHERE id = $1 RETURNING *', [cid]);
      await announce(c, r, EventTypes.consentRevoked);
    });
  }
}

/** Treating doctors: read and record allergies (audited; access decided by records-service). */
@Controller('v1/patients')
@RequireModule('emr')
export class StaffAllergiesController {
  constructor(private readonly db: TenantDbRouter, private readonly audit: AuditClient) {}

  private async assertCare(actor: Actor, patientId: string) {
    const { rows } = await this.db.query('SELECT 1 FROM patients WHERE id = $1', [patientId]);
    if (!rows[0]) throw notFound('patient');
    const a = await careAccess(TenantContext.require().id, actor.id, patientId);
    if (!a.allowed) throw new DomainError(403, 'NO_TREATING_RELATIONSHIP', 'you are not treating this patient');
    return a;
  }

  @Get(':patientId/allergies')
  @RequirePermission('record:read:treating')
  async list(@Param('patientId') p: string, @CurrentActor() actor: Actor) {
    const a = await this.assertCare(actor, id(p, 'patient'));
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: a.doctorName, action: 'READ', resourceType: 'ALLERGIES', patientId: p, purpose: a.purpose as any });
    const { rows } = await this.db.query('SELECT * FROM allergies WHERE patient_id = $1 AND removed_at IS NULL ORDER BY severity DESC, created_at', [p]);
    return rows.map(toAllergy);
  }

  @Post(':patientId/allergies')
  @RequirePermission('record:write:treating')
  async add(@Param('patientId') p: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const v = parse(NewAllergy, body);
    const a = await this.assertCare(actor, id(p, 'patient'));
    return this.db.tx(async (c) => {
      const r = await insertAllergy(c, p, v, actor, a.doctorName);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: a.doctorName, action: 'CREATE', resourceType: 'ALLERGY', resourceId: r.id, patientId: p, purpose: a.purpose as any });
      return r;
    });
  }
}

async function insertAllergy(c: Queryable, patientId: string, a: z.infer<typeof NewAllergy>, actor: Actor, name: string | null) {
  try {
    const { rows: [r] } = await c.query(
      `INSERT INTO allergies (id, patient_id, substance, severity, reaction, recorded_by, recorded_by_kind, recorded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), patientId, a.substance, a.severity, a.reaction, actor.id, actor.kind, name]);
    return toAllergy(r);
  } catch (e) {
    if ((e as any).code === '23505') throw new DomainError(409, 'ALLERGY_EXISTS', `${a.substance} is already recorded`);
    throw e;
  }
}

async function announce(c: Queryable, r: any, type: string) {
  const data = { consentId: r.id, patientId: r.patient_id, granteeDoctorId: r.grantee_id, scope: r.scope, validUntil: new Date(r.valid_until).toISOString(), revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null };
  await addToOutbox(c, Topics.patient, r.patient_id, envelope(type, data, { tenantId: TenantContext.require().id, subject: r.id }));
}
