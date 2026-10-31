import { Body, Controller, Get, HttpCode, Inject, Injectable, Logger, Param, Post, Query } from '@nestjs/common';
import { RequirePermission } from '@mc/entitlements-sdk';
import { CurrentActor, DomainError, forbidden, Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { type Actor, type PlacementSource, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { ObjectStorage } from '../documents/storage.js';
import { allergyConflicts } from '../records/allergy-check.js';
import { RecordAccess } from '../records/access.js';
import { AuditClient } from '../records/audit.client.js';
import { FORMULARY } from './drug-data.js';
import { checkPrescription, matchDrug, type SafetyReport } from './safety.js';

const MAX_AUDIO_BYTES = Number(process.env.SCRIBE_AUDIO_MAX_BYTES ?? 10 * 1024 * 1024);
const AUDIO_TYPES = ['audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac'];
const id = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };

export interface Allergy { substance: string; severity: string }

/** Recorded allergies (patient-service); null when they cannot be read right now. */
export async function allergiesOf(tenantId: string, patientId: string): Promise<Allergy[] | null> {
  const res = await fetch(`${process.env.SVC_URL_PATIENT ?? 'http://localhost:4406'}/internal/tenants/${tenantId}/patients/${patientId}/allergies`, {
    headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  return res?.ok ? ((await res.json()) as Allergy[]) : null;
}

/** Medicines the patient is on now: items of prescriptions whose course has not ended (no duration = 30 days). */
export async function currentMedicines(c: Queryable, patientId: string): Promise<{ drugName: string; prescriptionNo: string }[]> {
  const { rows } = await c.query(
    `SELECT i.drug_name, p.prescription_no FROM prescription_items i JOIN prescriptions p ON p.id = i.prescription_id
     WHERE p.patient_id = $1 AND p.issued_at + make_interval(days => coalesce(i.duration_days, 30)) > now() ORDER BY p.issued_at DESC`, [patientId]);
  return rows.map((r) => ({ drugName: r.drug_name, prescriptionNo: r.prescription_no }));
}

/**
 * The full deterministic check (Phase 25): allergy blocks from the existing matcher (review C-3), cross-reaction
 * cautions, interactions with each other and with current medicines, same-class duplicates, unknown drugs.
 */
export function fullCheck(items: { drugName: string }[], allergies: Allergy[], current: { drugName: string }[]): SafetyReport {
  const r = checkPrescription({ items, allergies, current });
  const blocks = allergyConflicts(items.map((i) => i.drugName), allergies);
  r.allergies = [
    ...blocks.map((b) => ({ drug: b.drug, allergy: b.substance, level: 'BLOCK' as const, reason: `recorded allergy (${b.severity.toLowerCase()})` })),
    ...r.allergies.filter((a) => a.level === 'CAUTION' && !blocks.some((b) => b.drug === a.drug)),
  ];
  return r;
}

@Injectable()
export class ScribeService {
  private readonly log = new Logger('Scribe');
  constructor(private readonly db: TenantDbRouter, private readonly crypto: FieldCrypto, private readonly storage: ObjectStorage, private readonly access: RecordAccess, private readonly audit: AuditClient) {}

  private async ownEncounter(c: Queryable, actor: Actor, encounterId: string) {
    const { rows: [e] } = await c.query('SELECT * FROM encounters WHERE id = $1 FOR UPDATE', [encounterId]);
    if (!e) throw notFound('encounter');
    const doctor = await this.access.doctorOf(c, actor);
    if (!doctor || doctor.id !== e.doctor_id) throw forbidden('NOT_AUTHOR', 'only the doctor of this visit can record it');
    if (e.status !== 'OPEN') throw new DomainError(409, 'ENCOUNTER_SIGNED', 'this visit is signed');
    return { e, doctor };
  }

  /** The patient agreed to the visit being recorded (asked per visit, docs/AI-AGENTS.md §10). */
  async consent(actor: Actor, encounterId: string, method: 'VERBAL' | 'WRITTEN') {
    return this.db.tx(async (c) => {
      const { e, doctor } = await this.ownEncounter(c, actor, encounterId);
      await c.query('UPDATE encounters SET scribe_consent_at = now(), scribe_consent_by = $2, scribe_consent_method = $3 WHERE id = $1', [encounterId, actor.id, method]);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: doctor.name, action: 'UPDATE', resourceType: 'SCRIBE_CONSENT', resourceId: encounterId, patientId: e.patient_id, purpose: 'TREATMENT' });
      return { consentedAt: new Date().toISOString(), method };
    });
  }

  /** A recording of this visit: only with consent, encrypted with the hospital's key, in its own bucket. */
  async addRecording(actor: Actor, encounterId: string, v: { mimeType: string; contentBase64: string }) {
    const t = TenantContext.require();
    const audio = Buffer.from(v.contentBase64, 'base64');
    if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new DomainError(422, 'BAD_RECORDING', `a recording is up to ${Math.round(MAX_AUDIO_BYTES / 1048576)} MB`);
    const rid = randomUUID();
    const key = `scribe/${encounterId}/${rid}`;
    return this.db.tx(async (c) => {
      const { e, doctor } = await this.ownEncounter(c, actor, encounterId);
      if (!e.scribe_consent_at) throw new DomainError(409, 'CONSENT_REQUIRED', 'record the patient\'s consent first');
      const bucket = this.storage.bucketFor(t.slug);
      await this.storage.ensureBucket(bucket);
      await this.storage.put(bucket, key, (await this.crypto.encrypt(t.id, `scribe:${rid}`, v.contentBase64))!, 'application/octet-stream');
      await c.query('INSERT INTO scribe_recordings (id, encounter_id, object_key, mime_type, size_bytes, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [rid, encounterId, key, v.mimeType, audio.length, actor.id]);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: doctor.name, action: 'CREATE', resourceType: 'SCRIBE_RECORDING', resourceId: rid, patientId: e.patient_id, purpose: 'TREATMENT' });
      return { recordingId: rid, sizeBytes: audio.length };
    });
  }

  /** For the assistant service (internal): the audio of a live recording, and the visit it belongs to. */
  async readRecording(recordingId: string) {
    const t = TenantContext.require();
    const { rows: [r] } = await this.db.query(`SELECT r.*, e.patient_id, e.status FROM scribe_recordings r JOIN encounters e ON e.id = r.encounter_id WHERE r.id = $1`, [recordingId]);
    if (!r || r.deleted_at) throw notFound('recording');
    const b64 = await this.crypto.decrypt(t.id, `scribe:${r.id}`, await this.storage.read(this.storage.bucketFor(t.slug), r.object_key));
    return { recordingId: r.id, encounterId: r.encounter_id, patientId: r.patient_id, mimeType: r.mime_type, contentBase64: b64 };
  }

  /** Audio goes once the visit is signed, or after SCRIBE_AUDIO_HOURS (24) at the latest. The rows stay as the trail. */
  async purge(where: { encounterId?: string; olderThanHours?: number }, reason: string) {
    const t = TenantContext.require();
    const { rows } = where.encounterId
      ? await this.db.query('UPDATE scribe_recordings SET deleted_at = now(), delete_reason = $2 WHERE encounter_id = $1 AND deleted_at IS NULL RETURNING object_key', [where.encounterId, reason])
      : await this.db.query(`UPDATE scribe_recordings SET deleted_at = now(), delete_reason = $2 WHERE deleted_at IS NULL AND created_at < now() - make_interval(hours => $1) RETURNING object_key`, [where.olderThanHours ?? 24, reason]);
    for (const r of rows) await this.storage.delete(this.storage.bucketFor(t.slug), r.object_key).catch((e) => this.log.warn(`${t.slug}: audio not deleted (${(e as Error).message}); retried by the sweep`));
    return rows.length;
  }
}

const Item = z.object({ drugName: z.string().trim().min(2).max(150) });
const Check = z.object({ items: z.array(Item).min(1).max(20) });
const Consent = z.object({ method: z.enum(['VERBAL', 'WRITTEN']).default('VERBAL') });
const Recording = z.object({ mimeType: z.string().refine((m) => AUDIO_TYPES.includes(m.split(';')[0]), 'an audio file (wav, webm, ogg, mp3, m4a)'), contentBase64: z.string().min(8) });

/** Prescription safety and the formulary, for the doctor's screens and the AI scribe (always with the doctor's token). */
@Controller('v1')
export class PrescribingController {
  constructor(private readonly db: TenantDbRouter, private readonly access: RecordAccess, private readonly scribe: ScribeService) {}

  /** The formulary: what a written drug name matches (for typing ahead and for checking a scribe draft). */
  @Get('formulary')
  @RequirePermission('record:read:treating')
  formulary(@Query('q') q?: string) {
    const term = (q ?? '').trim().toLowerCase();
    const match = term ? matchDrug(term) : null;
    const list = FORMULARY.filter((d) => !term || d.generic.toLowerCase().includes(term) || d.brands.some((b) => b.toLowerCase().includes(term)) || d.code === match?.code).slice(0, 20);
    return list.map((d) => ({ code: d.code, generic: d.generic, brands: d.brands, drugClass: d.drugClass, forms: d.forms, strengths: d.strengths }));
  }

  /** Check a prescription before issuing it: allergies, interactions (also with current medicines), duplicates. */
  @Post('patients/:patientId/prescription-check')
  @RequirePermission('record:read:treating')
  @HttpCode(200)
  async check(@Param('patientId') p: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const v = parse(Check, body);
    const c = await this.db.current();
    await this.access.assertCanRead(c, actor, id(p, 'patient'), 'PRESCRIPTION');
    const allergies = await allergiesOf(TenantContext.require().id, p);
    const current = await currentMedicines(c, p);
    return {
      ...fullCheck(v.items, allergies ?? [], current), allergiesChecked: allergies !== null, current,
      matches: v.items.map((i) => { const d = matchDrug(i.drugName); return { drugName: i.drugName, code: d?.code ?? null, generic: d?.generic ?? null }; }),
    };
  }

  @Post('encounters/:id/scribe-consent')
  @RequirePermission('record:write:treating')
  @HttpCode(200)
  consent(@Param('id') e: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.scribe.consent(actor, id(e, 'encounter'), parse(Consent, body ?? {}).method);
  }

  @Post('encounters/:id/recordings')
  @RequirePermission('record:write:treating')
  recording(@Param('id') e: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.scribe.addRecording(actor, id(e, 'encounter'), parse(Recording, body));
  }
}

@Controller('internal/tenants/:tenantId/recordings')
export class InternalRecordingsController {
  constructor(private readonly scribe: ScribeService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get(':id')
  @Internal()
  async read(@Param('tenantId') t: string, @Param('id') r: string) {
    id(t, 'tenant');
    return TenantContext.run(await this.placements.get(t), () => this.scribe.readRecording(id(r, 'recording')));
  }
}
