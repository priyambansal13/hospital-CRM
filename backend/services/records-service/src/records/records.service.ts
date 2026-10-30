import { type Allergy, allergyConflicts } from './allergy-check.js';
import { Inject, Injectable } from '@nestjs/common';
import { type BreakGlassGranted, EventTypes, type PrescriptionIssued, Topics } from '@mc/contracts';
import { conflict, CONTROL_DB, DomainError, forbidden, notFound } from '@mc/nest-common';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { BREAK_GLASS_HOURS, type Decision, RecordAccess } from './access.js';
import { AuditClient } from './audit.client.js';
import { TimelineService } from '../timeline/timeline.service.js';
import { TriageService } from './triage.js';

export interface Vitals { bp?: string; pulse?: number; tempC?: number; weightKg?: number; heightCm?: number; spo2?: number; respRate?: number }
export interface DiagnosisIn { code?: string | null; description?: string | null; isPrimary?: boolean }
export interface ItemIn { drugName: string; strength?: string | null; form?: string | null; dosage: string; durationDays?: number | null; instructions?: string | null }

const age = (dob: string | Date | null) => {
  if (!dob) return null;
  const d = new Date(dob);
  const n = new Date();
  let y = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) y--;
  return y;
};
export const toPatient = (p: any) => ({ id: p.id, name: p.name, mrn: p.mrn, dob: p.dob ? new Date(p.dob).toISOString().slice(0, 10) : null, age: age(p.dob), gender: p.gender });

@Injectable()
export class RecordsService {
  constructor(
    private readonly db: TenantDbRouter,
    private readonly crypto: FieldCrypto,
    private readonly access: RecordAccess,
    private readonly audit: AuditClient,
    private readonly timeline: TimelineService,
    private readonly triage: TriageService,
    /** control plane: the shared ICD-10 reference list */
    @Inject(CONTROL_DB) private readonly control: pg.Pool,
  ) {}

  private tid() { return TenantContext.require().id; }

  private async author(c: Queryable, actor: Actor, e: any) {
    const doctor = await this.access.doctorOf(c, actor);
    if (!doctor || doctor.id !== e.doctor_id) throw forbidden('NOT_AUTHOR', 'only the doctor who wrote this visit can change it');
    return doctor;
  }

  private async encounterRow(c: Queryable, id: string, lock = false) {
    const { rows } = await c.query(`SELECT * FROM encounters WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!rows[0]) throw notFound('encounter');
    return rows[0];
  }

  /** The visit, decrypted, with diagnoses, prescriptions and amendment history. Caller has checked access. */
  async encounterDto(c: Queryable, e: any, opts: { notes: boolean } = { notes: true }) {
    const t = this.tid();
    const [{ rows: dx }, { rows: rx }, { rows: am }, { rows: [doc] }, { rows: [pat] }] = await Promise.all([
      c.query('SELECT * FROM diagnoses WHERE encounter_id = $1 ORDER BY is_primary DESC, description', [e.id]),
      c.query('SELECT id FROM prescriptions WHERE encounter_id = $1 ORDER BY issued_at', [e.id]),
      c.query(`SELECT a.reason, a.changed, a.amended_at, d.name FROM encounter_amendments a LEFT JOIN doctors d ON d.id = a.amended_by WHERE a.encounter_id = $1 ORDER BY a.amended_at`, [e.id]),
      c.query('SELECT id, name FROM doctors WHERE id = $1', [e.doctor_id]),
      c.query('SELECT * FROM patients WHERE id = $1', [e.patient_id]),
    ]);
    return {
      id: e.id, appointmentId: e.appointment_id, status: e.status, startedAt: e.started_at, signedAt: e.signed_at, version: e.version,
      patient: pat ? toPatient(pat) : { id: e.patient_id }, doctor: doc ?? { id: e.doctor_id, name: 'Doctor' },
      vitals: e.vitals ?? {},
      chiefComplaint: await this.crypto.decrypt(t, `encounters.complaint:${e.id}`, e.complaint_enc),
      notes: opts.notes ? await this.crypto.decrypt(t, `encounters.notes:${e.id}`, e.notes_enc) : undefined,
      diagnoses: dx.map((d) => ({ code: d.icd10_code, description: d.description, isPrimary: d.is_primary })),
      prescriptions: await Promise.all(rx.map((r) => this.prescriptionDto(c, r.id))),
      amendments: am.map((a) => ({ reason: a.reason, changed: a.changed, at: a.amended_at, by: a.name })),
    };
  }

  async prescriptionDto(c: Queryable, id: string) {
    const { rows: [p] } = await c.query(
      `SELECT p.*, d.name AS doctor_name, pt.name AS patient_name, pt.mrn, pt.dob, pt.gender, pt.account_person_id
       FROM prescriptions p LEFT JOIN doctors d ON d.id = p.doctor_id LEFT JOIN patients pt ON pt.id = p.patient_id WHERE p.id = $1`, [id]);
    if (!p) throw notFound('prescription');
    const [{ rows: items }, { rows: dx }] = await Promise.all([
      c.query('SELECT * FROM prescription_items WHERE prescription_id = $1 ORDER BY position', [id]),
      c.query('SELECT icd10_code, description FROM diagnoses WHERE encounter_id = $1 ORDER BY is_primary DESC', [p.encounter_id]),
    ]);
    return {
      id: p.id, prescriptionNo: p.prescription_no, encounterId: p.encounter_id, issuedAt: p.issued_at,
      followUpOn: p.follow_up_on ? new Date(p.follow_up_on).toISOString().slice(0, 10) : null,
      advice: await this.crypto.decrypt(this.tid(), `prescriptions.advice:${p.id}`, p.advice_enc),
      doctor: { id: p.doctor_id, name: p.doctor_name },
      patient: { id: p.patient_id, name: p.patient_name, mrn: p.mrn, age: age(p.dob), gender: p.gender },
      accountPersonId: p.account_person_id,
      diagnoses: dx.map((d) => ({ code: d.icd10_code, description: d.description })),
      items: items.map((i) => ({ drugName: i.drug_name, strength: i.strength, form: i.form, dosage: i.dosage, durationDays: i.duration_days, instructions: i.instructions })),
    };
  }

  // ---------- encounters ----------

  /** Start (or reopen) the visit for an appointment: only its doctor, once the patient is there (or on video). */
  async openForAppointment(actor: Actor, appointmentId: string) {
    return this.db.tx(async (c) => {
      const doctor = await this.access.doctorOf(c, actor);
      const { rows: [a] } = await c.query('SELECT * FROM care_appointments WHERE appointment_id = $1', [appointmentId]);
      if (!a || !doctor || a.doctor_id !== doctor.id) throw notFound('appointment');
      const { rows: existing } = await c.query('SELECT * FROM encounters WHERE appointment_id = $1', [appointmentId]);
      if (existing[0]) return { created: false, encounter: await this.readEncounter(c, actor, existing[0], { purpose: 'TREATMENT', doctor, actorName: doctor.name }) };
      const ready = ['CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'].includes(a.status) || (a.status === 'CONFIRMED' && a.mode === 'VIDEO');
      if (!ready) throw new DomainError(422, 'PATIENT_NOT_HERE', a.status === 'CONFIRMED' ? 'the patient has not checked in yet' : `the appointment is ${a.status.toLowerCase().replace('_', ' ')}`);
      const id = randomUUID();
      await c.query(`INSERT INTO encounters (id, appointment_id, patient_id, doctor_id, branch_id, status) VALUES ($1,$2,$3,$4,$5,'OPEN')`,
        [id, appointmentId, a.patient_id, doctor.id, a.branch_id]);
      await this.triage.copyIntoEncounter(c, appointmentId, id);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: doctor.name, action: 'CREATE', resourceType: 'ENCOUNTER', resourceId: id, patientId: a.patient_id, purpose: 'TREATMENT' });
      return { created: true, encounter: await this.encounterDto(c, await this.encounterRow(c, id)) };
    });
  }

  async readEncounter(c: Queryable, actor: Actor, e: any, decision?: Decision) {
    const d = decision ?? await this.access.assertCanRead(c, actor, e.patient_id, 'ENCOUNTER');
    await this.audit.record({ actorId: actor.id, actorKind: actor.kind, actorName: d.actorName, action: 'READ', resourceType: 'ENCOUNTER', resourceId: e.id, patientId: e.patient_id, purpose: d.purpose });
    return { ...(await this.encounterDto(c, e, { notes: d.purpose !== 'PATIENT_SELF' })), access: { purpose: d.purpose, breakGlassUntil: d.breakGlassUntil ?? null } };
  }

  async getEncounter(actor: Actor, id: string) {
    const c = await this.db.current();
    return this.readEncounter(c, actor, await this.encounterRow(c, id));
  }

  async byAppointment(actor: Actor, appointmentId: string) {
    const c = await this.db.current();
    const { rows } = await c.query('SELECT * FROM encounters WHERE appointment_id = $1', [appointmentId]);
    if (!rows[0]) throw notFound('encounter');
    return this.readEncounter(c, actor, rows[0]);
  }

  /** Draft changes while OPEN (author only); optimistic lock on version. */
  async update(actor: Actor, id: string, v: { version: number; vitals?: Vitals; chiefComplaint?: string | null; notes?: string | null; diagnoses?: DiagnosisIn[] }) {
    return this.db.tx(async (c) => {
      const e = await this.encounterRow(c, id, true);
      const doctor = await this.author(c, actor, e);
      if (e.status !== 'OPEN') throw conflict('ENCOUNTER_SIGNED', 'this visit is signed; add an amendment instead');
      if (e.version !== v.version) throw conflict('VERSION_CONFLICT', 'the visit changed in another window; reload');
      const changed = await this.applyContent(c, e, v);
      await c.query('UPDATE encounters SET version = version + 1, updated_at = now() WHERE id = $1', [id]);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: doctor.name, action: 'UPDATE', resourceType: 'ENCOUNTER', resourceId: id, patientId: e.patient_id, purpose: 'TREATMENT', changes: changed });
      return this.encounterDto(c, await this.encounterRow(c, id));
    });
  }

  private async applyContent(c: Queryable, e: any, v: { vitals?: Vitals; chiefComplaint?: string | null; notes?: string | null; diagnoses?: DiagnosisIn[] }) {
    const t = this.tid();
    const changed: string[] = [];
    if (v.vitals !== undefined) { await c.query('UPDATE encounters SET vitals = $2 WHERE id = $1', [e.id, JSON.stringify(v.vitals)]); changed.push('vitals'); }
    if (v.chiefComplaint !== undefined) { await c.query('UPDATE encounters SET complaint_enc = $2 WHERE id = $1', [e.id, await this.crypto.encrypt(t, `encounters.complaint:${e.id}`, v.chiefComplaint)]); changed.push('chiefComplaint'); }
    if (v.notes !== undefined) { await c.query('UPDATE encounters SET notes_enc = $2 WHERE id = $1', [e.id, await this.crypto.encrypt(t, `encounters.notes:${e.id}`, v.notes)]); changed.push('notes'); }
    if (v.diagnoses !== undefined) {
      const resolved = await this.resolveDiagnoses(v.diagnoses);
      await c.query('DELETE FROM diagnoses WHERE encounter_id = $1', [e.id]);
      for (const d of resolved) await c.query('INSERT INTO diagnoses (id, encounter_id, icd10_code, description, is_primary) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), e.id, d.code, d.description, d.isPrimary]);
      changed.push('diagnoses');
    }
    return changed;
  }

  /** ICD-10 codes must exist in the reference list (its title is the default description); exactly one primary. */
  private async resolveDiagnoses(list: DiagnosisIn[]) {
    const codes = list.map((d) => d.code).filter(Boolean) as string[];
    const titles = new Map<string, string>();
    if (codes.length) for (const r of (await this.control.query('SELECT code, title FROM icd10_codes WHERE code = ANY($1)', [codes])).rows) titles.set(r.code, r.title);
    const out = list.map((d) => {
      if (d.code && !titles.has(d.code)) throw new DomainError(422, 'UNKNOWN_ICD10', `unknown ICD-10 code ${d.code}`);
      const description = (d.description?.trim() || (d.code ? titles.get(d.code) : '') || '').slice(0, 200);
      if (description.length < 2) throw new DomainError(422, 'DIAGNOSIS_REQUIRED', 'a diagnosis needs a code or a description');
      return { code: d.code ?? null, description, isPrimary: !!d.isPrimary };
    });
    if (out.length && !out.some((d) => d.isPrimary)) out[0].isPrimary = true;
    if (out.filter((d) => d.isPrimary).length > 1) throw new DomainError(422, 'ONE_PRIMARY_DIAGNOSIS', 'mark one diagnosis as primary');
    return out;
  }

  async sign(actor: Actor, id: string, version: number) {
    return this.db.tx(async (c) => {
      const e = await this.encounterRow(c, id, true);
      const doctor = await this.author(c, actor, e);
      if (e.status !== 'OPEN') throw conflict('ENCOUNTER_SIGNED', 'already signed');
      if (e.version !== version) throw conflict('VERSION_CONFLICT', 'the visit changed in another window; reload');
      const { rows: dx } = await c.query('SELECT 1 FROM diagnoses WHERE encounter_id = $1', [id]);
      if (!dx.length) throw new DomainError(422, 'DIAGNOSIS_REQUIRED', 'add at least one diagnosis before signing');
      await c.query(`UPDATE encounters SET status = 'SIGNED', signed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: doctor.name, action: 'SIGN', resourceType: 'ENCOUNTER', resourceId: id, patientId: e.patient_id, purpose: 'TREATMENT' });
      await addToOutbox(c, Topics.records, e.patient_id, envelope(EventTypes.encounterSigned, { encounterId: id, patientId: e.patient_id, doctorId: e.doctor_id, appointmentId: e.appointment_id }, { tenantId: this.tid(), subject: id }));
      await this.timelineVisit(c, id, doctor.name);
      return this.encounterDto(c, await this.encounterRow(c, id));
    });
  }

  /** After signing: corrections are amendments; what they replace is kept (encrypted) with the reason. */
  async amend(actor: Actor, id: string, v: { reason: string; chiefComplaint?: string | null; notes?: string | null; diagnoses?: DiagnosisIn[] }) {
    return this.db.tx(async (c) => {
      const e = await this.encounterRow(c, id, true);
      const doctor = await this.author(c, actor, e);
      if (e.status === 'OPEN') throw conflict('NOT_SIGNED', 'the visit is still a draft; edit it directly');
      const before = await this.encounterDto(c, e);
      const amendId = randomUUID();
      const snapshot = JSON.stringify({ chiefComplaint: before.chiefComplaint, notes: before.notes, diagnoses: before.diagnoses });
      const changed = await this.applyContent(c, e, v);
      if (!changed.length) throw new DomainError(422, 'NOTHING_TO_AMEND', 'change at least one field');
      await c.query('INSERT INTO encounter_amendments (id, encounter_id, reason, previous_enc, changed, amended_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [amendId, id, v.reason, await this.crypto.encrypt(this.tid(), `amendments.previous:${amendId}`, snapshot), changed, doctor.id]);
      await c.query(`UPDATE encounters SET status = 'AMENDED', version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await this.timelineVisit(c, id, doctor.name);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: doctor.name, action: 'AMEND', resourceType: 'ENCOUNTER', resourceId: id, patientId: e.patient_id, purpose: 'TREATMENT', changes: changed });
      return this.encounterDto(c, await this.encounterRow(c, id));
    });
  }

  /** Timeline: a signed visit, labelled with its primary diagnosis (no notes). */
  private async timelineVisit(c: Queryable, id: string, doctorName: string) {
    const e = await this.encounterRow(c, id);
    const { rows } = await c.query('SELECT description FROM diagnoses WHERE encounter_id = $1 ORDER BY is_primary DESC LIMIT 1', [id]);
    await this.timeline.upsert(c, { patientId: e.patient_id, kind: 'ENCOUNTER', refId: id, occurredAt: e.signed_at ?? e.started_at, title: `Visit with ${doctorName}`, summary: { diagnosis: rows[0]?.description ?? null, status: e.status }, doctorId: e.doctor_id, branchId: e.branch_id });
  }

  // ---------- prescriptions ----------

  /** Recorded allergies for the patient (patient-service); null when they cannot be read right now. */
  private async allergiesOf(patientId: string): Promise<Allergy[] | null> {
    const res = await fetch(`${process.env.SVC_URL_PATIENT ?? 'http://localhost:4406'}/internal/tenants/${this.tid()}/patients/${patientId}/allergies`, {
      headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    return res?.ok ? ((await res.json()) as Allergy[]) : null;
  }

  async prescribe(actor: Actor, encounterId: string, v: { items: ItemIn[]; advice?: string | null; followUpOn?: string | null; allergyOverride?: string | null }) {
    // allergy check before anything is written (docs/ROLE-FLOWS-AND-GAPS.md C-3): a clash needs the doctor's reason
    const { rows: [pe] } = await this.db.query('SELECT patient_id FROM encounters WHERE id = $1', [encounterId]);
    if (!pe) throw notFound('encounter');
    const allergies = await this.allergiesOf(pe.patient_id);
    if (!v.allergyOverride) {
      if (!allergies) throw new DomainError(503, 'ALLERGIES_UNAVAILABLE', 'allergies could not be checked right now: try again, or give a reason to prescribe anyway');
      const conflicts = allergyConflicts(v.items.map((i) => i.drugName), allergies);
      if (conflicts.length) {
        throw conflict('ALLERGY_CONFLICT', `recorded allergy: ${conflicts.map((x) => `${x.drug} vs ${x.substance} (${x.severity.toLowerCase()})`).join('; ')}. Change the medicine, or give a reason to prescribe anyway`, { conflicts });
      }
    }
    return this.db.tx(async (c) => {
      const e = await this.encounterRow(c, encounterId, true);
      const doctor = await this.author(c, actor, e);
      const id = randomUUID();
      const { rows: [{ no }] } = await c.query(`SELECT 'RX-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('prescription_seq')::text, 6, '0') AS no`);
      await c.query('INSERT INTO prescriptions (id, prescription_no, encounter_id, patient_id, doctor_id, advice_enc, follow_up_on, allergy_override_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, no, encounterId, e.patient_id, doctor.id, await this.crypto.encrypt(this.tid(), `prescriptions.advice:${id}`, v.advice), v.followUpOn ?? null, v.allergyOverride ?? null]);
      let pos = 0;
      for (const i of v.items) {
        await c.query('INSERT INTO prescription_items (id, prescription_id, position, drug_name, strength, form, dosage, duration_days, instructions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [randomUUID(), id, pos++, i.drugName, i.strength ?? null, i.form ?? null, i.dosage, i.durationDays ?? null, i.instructions ?? null]);
      }
      const rx = await this.prescriptionDto(c, id);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: doctor.name, action: 'CREATE', resourceType: 'PRESCRIPTION', resourceId: id, patientId: e.patient_id, purpose: 'TREATMENT', changes: v.allergyOverride ? ['allergy_override'] : null });
      const data: PrescriptionIssued = { prescriptionId: id, prescriptionNo: no, encounterId, patientId: e.patient_id, accountPersonId: rx.accountPersonId, patientName: rx.patient.name, doctorId: doctor.id, doctorName: doctor.name, itemCount: v.items.length };
      await addToOutbox(c, Topics.records, e.patient_id, envelope(EventTypes.prescriptionIssued, data, { tenantId: this.tid(), subject: id }));
      await this.timeline.upsert(c, { patientId: e.patient_id, kind: 'PRESCRIPTION', refId: id, occurredAt: rx.issuedAt, title: `Prescription ${no}`, summary: { items: v.items.length, doctor: doctor.name }, doctorId: doctor.id, branchId: e.branch_id });
      return rx;
    });
  }

  async getPrescription(actor: Actor, id: string, action: 'READ' | 'EXPORT' = 'READ') {
    const c = await this.db.current();
    const { rows } = await c.query('SELECT patient_id FROM prescriptions WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('prescription');
    const d = await this.access.assertCanRead(c, actor, rows[0].patient_id, 'PRESCRIPTION');
    await this.audit.record({ actorId: actor.id, actorKind: actor.kind, actorName: d.actorName, action, resourceType: 'PRESCRIPTION', resourceId: id, patientId: rows[0].patient_id, purpose: d.purpose });
    return this.prescriptionDto(c, id);
  }

  /** Everything the account's patients (self + family) were prescribed. Audited as their own reads. */
  async myPrescriptions(actor: Actor) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'patients only');
    const c = await this.db.current();
    const { rows } = await c.query(`SELECT p.id, p.patient_id FROM prescriptions p JOIN patients pt ON pt.id = p.patient_id WHERE pt.account_person_id = $1 ORDER BY p.issued_at DESC LIMIT 100`, [actor.id]);
    const patients = [...new Set(rows.map((r) => r.patient_id))];
    if (patients.length) await this.audit.record(...patients.map((pid) => ({ actorId: actor.id, actorKind: 'patient' as const, action: 'READ' as const, resourceType: 'PRESCRIPTION_LIST', patientId: pid, purpose: 'PATIENT_SELF' as const })));
    return Promise.all(rows.map((r) => this.prescriptionDto(c, r.id)));
  }

  // ---------- chart, lookup, break-glass ----------

  async chart(actor: Actor, patientId: string) {
    const c = await this.db.current();
    const d = await this.access.assertCanRead(c, actor, patientId, 'CHART');
    await this.audit.record({ actorId: actor.id, actorKind: actor.kind, actorName: d.actorName, action: d.purpose === 'BREAK_GLASS' ? 'BREAK_GLASS' : 'READ', resourceType: 'CHART', patientId, purpose: d.purpose });
    const [{ rows: [p] }, { rows: encs }] = await Promise.all([
      c.query('SELECT * FROM patients WHERE id = $1', [patientId]),
      c.query('SELECT * FROM encounters WHERE patient_id = $1 ORDER BY started_at DESC LIMIT 50', [patientId]),
    ]);
    return {
      patient: toPatient(p), access: { purpose: d.purpose, breakGlassUntil: d.breakGlassUntil ?? null },
      encounters: await Promise.all(encs.map((e) => this.encounterDto(c, e, { notes: d.purpose !== 'PATIENT_SELF' }))),
    };
  }

  /** Exact MRN lookup for doctors (to open a chart, or start break-glass). Says whether they may open it. */
  async lookup(actor: Actor, mrn: string) {
    const c = await this.db.current();
    const doctor = await this.access.doctorOf(c, actor);
    if (!doctor) throw forbidden('DOCTORS_ONLY', 'only doctors can look up patient records');
    const { rows } = await c.query('SELECT * FROM patients WHERE mrn = upper($1)', [mrn.trim()]);
    if (!rows[0]) throw notFound('patient');
    const p = rows[0];
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: doctor.name, action: 'LOOKUP', resourceType: 'PATIENT', resourceId: p.id, patientId: p.id, purpose: 'NONE' });
    const access = (await this.access.treating(c, doctor.id, p.id)) ? 'TREATING' : (await this.access.breakGlass(c, doctor.id, p.id)) ? 'BREAK_GLASS' : 'NONE';
    return { patient: { id: p.id, name: p.name, mrn: p.mrn, age: toPatient(p).age, gender: p.gender }, access };
  }

  /** Emergency access: time-boxed, reason required, audited as BREAK_GLASS and announced (compliance alert). */
  async breakGlass(actor: Actor, patientId: string, reason: string) {
    return this.db.tx(async (c) => {
      const doctor = await this.access.doctorOf(c, actor);
      if (!doctor) throw forbidden('DOCTORS_ONLY', 'only doctors can use emergency access');
      if (!(await this.access.patient(c, patientId))) throw notFound('patient');
      const id = randomUUID();
      const { rows: [g] } = await c.query(`INSERT INTO break_glass_grants (id, doctor_id, patient_id, reason, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5)) RETURNING expires_at`,
        [id, doctor.id, patientId, reason, BREAK_GLASS_HOURS]);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: doctor.name, action: 'BREAK_GLASS', resourceType: 'GRANT', resourceId: id, patientId, purpose: 'BREAK_GLASS' });
      const data: BreakGlassGranted = { grantId: id, patientId, doctorId: doctor.id, doctorName: doctor.name, reason, expiresAt: new Date(g.expires_at).toISOString() };
      await addToOutbox(c, Topics.records, patientId, envelope(EventTypes.breakGlassGranted, data, { tenantId: this.tid(), subject: id }));
      return { grantId: id, expiresAt: data.expiresAt };
    });
  }
}
