import { Injectable } from '@nestjs/common';
import { DomainError, notFound } from '@mc/nest-common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { type Actor, type Queryable, TenantContext } from '@mc/tenancy';
import { AuditClient } from './audit.client.js';

export const TREATING_WINDOW_DAYS = Number(process.env.TREATING_WINDOW_DAYS ?? 365);
export const BREAK_GLASS_HOURS = Number(process.env.BREAK_GLASS_HOURS ?? 4);

export type Scope = 'NOTES' | 'PRESCRIPTIONS' | 'DOCUMENTS' | 'ANY';
export interface Decision {
  purpose: 'TREATMENT' | 'BREAK_GLASS' | 'CONSENT' | 'PATIENT_SELF'; doctor: { id: string; name: string } | null; actorName: string | null;
  breakGlassUntil?: string;
  /** CONSENT only: what the patient shared */
  consentScope?: string[];
}
/** which consent scope a resource needs */
export const SCOPE_OF: Record<string, Scope> = { CHART: 'NOTES', ENCOUNTER: 'NOTES', PRESCRIPTION: 'PRESCRIPTIONS', DOCUMENT: 'DOCUMENTS', DOCUMENT_LIST: 'DOCUMENTS', TIMELINE: 'ANY' };

/**
 * Who may read a patient's clinical record (docs/LLD.md §7): the patient's own account (self and family), or a doctor
 * with a TREATING relationship (an appointment that was not cancelled, or a visit, within the window), the patient's
 * CONSENT (per scope, until it expires or is revoked), or an active BREAK-GLASS grant. Nobody else — not admins, not
 * receptionists. Every decision is audited.
 */
@Injectable()
export class RecordAccess {
  constructor(private readonly audit: AuditClient, private readonly entitlements: EntitlementsClient) {}

  async doctorOf(c: Queryable, actor: Actor) {
    if (actor.kind !== 'staff') return null;
    const { rows } = await c.query('SELECT id, name FROM doctors WHERE user_id = $1', [actor.id]);
    return (rows[0] as { id: string; name: string } | undefined) ?? null;
  }

  async treating(c: Queryable, doctorId: string, patientId: string): Promise<boolean> {
    const { rows } = await c.query(
      `SELECT EXISTS (SELECT 1 FROM care_appointments WHERE doctor_id = $1 AND patient_id = $2
                        AND status NOT IN ('CANCELLED','EXPIRED','RESCHEDULED','PENDING_PAYMENT') AND starts_at > now() - make_interval(days => $3))
           OR EXISTS (SELECT 1 FROM encounters WHERE doctor_id = $1 AND patient_id = $2) AS ok`, [doctorId, patientId, TREATING_WINDOW_DAYS]);
    return rows[0].ok;
  }

  async breakGlass(c: Queryable, doctorId: string, patientId: string): Promise<string | null> {
    const { rows } = await c.query(`SELECT max(expires_at) AS until FROM break_glass_grants WHERE doctor_id = $1 AND patient_id = $2 AND expires_at > now()`, [doctorId, patientId]);
    return rows[0].until ? new Date(rows[0].until).toISOString() : null;
  }

  /**
   * The patient from the read model; if the registration event has not arrived yet (a brand-new patient opening
   * their record seconds after signing up), read through to patient-service and store it.
   */
  async patient(c: Queryable, patientId: string): Promise<{ id: string; account_person_id: string } | null> {
    const { rows } = await c.query('SELECT id, account_person_id FROM patients WHERE id = $1', [patientId]);
    if (rows[0]) return rows[0];
    const res = await fetch(`${process.env.SVC_URL_PATIENT ?? 'http://localhost:4406'}/internal/tenants/${TenantContext.require().id}/patients/${patientId}`, {
      headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (!res || res.status === 404) return null;
    if (!res.ok) throw new DomainError(502, 'PATIENTS_UNAVAILABLE', `patient-service ${res.status}`);
    const p = (await res.json()) as { id: string; accountPersonId: string; mrn: string; fullName: string; dob: string | null; gender: string | null };
    // no conflict target: the registration event (or a parallel request) may be inserting the same patient right now,
    // and the unique MRN index can be the one that reports it
    await c.query(`INSERT INTO patients (id, account_person_id, mrn, name, dob, gender) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [p.id, p.accountPersonId, p.mrn, p.fullName, p.dob, p.gender]);
    return { id: p.id, account_person_id: p.accountPersonId };
  }

  /** An active consent from the patient to this doctor covering `scope` (ANY = any scope). */
  async consent(c: Queryable, doctorId: string, patientId: string, scope: Scope): Promise<string[] | null> {
    const { rows } = await c.query(
      `SELECT array_agg(DISTINCT s) AS scope FROM consents, unnest(scope) s WHERE doctor_id = $1 AND patient_id = $2 AND revoked_at IS NULL AND valid_until > now()`, [doctorId, patientId]);
    const granted: string[] = rows[0]?.scope ?? [];
    if (!granted.length) return null;
    return scope === 'ANY' || granted.includes(scope) ? granted : null;
  }

  /**
   * The decision alone, no side effects (also answers patient-service's "is this doctor treating?"): patient self;
   * doctor treating; doctor with the patient's consent for this scope; doctor with an active break-glass grant.
   * null = no access; undefined = no such patient.
   */
  async decide(c: Queryable, actor: Actor, patientId: string, scope: Scope): Promise<Decision | null | undefined> {
    const p = await this.patient(c, patientId);
    if (!p) return undefined;
    if (actor.kind === 'patient') return p.account_person_id === actor.id ? { purpose: 'PATIENT_SELF', doctor: null, actorName: null } : undefined;
    const doctor = await this.doctorOf(c, actor);
    if (!doctor) return null;
    if (await this.treating(c, doctor.id, patientId)) return { purpose: 'TREATMENT', doctor, actorName: doctor.name };
    const consentScope = await this.consent(c, doctor.id, patientId, scope);
    if (consentScope) return { purpose: 'CONSENT', doctor, actorName: doctor.name, consentScope };
    const until = await this.breakGlass(c, doctor.id, patientId);
    if (until) return { purpose: 'BREAK_GLASS', doctor, actorName: doctor.name, breakGlassUntil: until };
    return null;
  }

  /** Decide, or audit the refusal and throw 403 (404 when the patient does not exist here or isn't the caller's). */
  async assertCanRead(c: Queryable, actor: Actor, patientId: string, resourceType: string): Promise<Decision> {
    const d = await this.decide(c, actor, patientId, SCOPE_OF[resourceType] ?? 'NOTES');
    if (d === undefined) throw notFound('patient');
    if (d) return d;
    const doctor = await this.doctorOf(c, actor);
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: doctor?.name ?? actor.email ?? null, action: 'DENIED', resourceType, patientId, purpose: 'NONE' });
    const caps = await this.entitlements.capabilities(TenantContext.require().id, actor);
    throw new DomainError(403, 'NO_TREATING_RELATIONSHIP', doctor
      ? 'you have no appointment or visit with this patient; use emergency access (break-glass) if this is an emergency'
      : 'clinical records are open only to the patient and their treating doctors',
    { breakGlassAvailable: !!doctor && caps.permissions.includes('record:break_glass:tenant') });
  }
}
