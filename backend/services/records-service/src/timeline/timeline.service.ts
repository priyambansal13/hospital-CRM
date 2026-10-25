import { Injectable } from '@nestjs/common';
import type { Actor, Queryable } from '@mc/tenancy';
import { TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { RecordAccess } from '../records/access.js';
import { AuditClient } from '../records/audit.client.js';

export type Kind = 'APPOINTMENT' | 'ENCOUNTER' | 'PRESCRIPTION' | 'LAB_ORDER' | 'REPORT' | 'DOCUMENT';
export interface Entry { patientId: string; kind: Kind; refId: string; occurredAt: Date | string; title: string; summary?: Record<string, unknown>; doctorId?: string | null; branchId?: string | null }

/** What a consented doctor may see on the timeline, by what the patient shared. */
const KINDS_FOR_SCOPE: Record<string, Kind[]> = { NOTES: ['ENCOUNTER'], PRESCRIPTIONS: ['PRESCRIPTION'], DOCUMENTS: ['DOCUMENT', 'REPORT', 'LAB_ORDER'] };

/**
 * The health timeline (docs/LLD.md §11): a read model, one row per thing, small non-clinical summary; details are
 * opened through the owning endpoint, which re-checks access and audits.
 */
@Injectable()
export class TimelineService {
  constructor(private readonly db: TenantDbRouter, private readonly access: RecordAccess, private readonly audit: AuditClient) {}

  async upsert(c: Queryable, e: Entry) {
    await c.query(
      `INSERT INTO timeline_entries (id, patient_id, occurred_at, kind, ref_id, title, summary, doctor_id, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (kind, ref_id) DO UPDATE SET occurred_at = $3, title = $6, summary = $7, doctor_id = coalesce($8, timeline_entries.doctor_id), branch_id = coalesce($9, timeline_entries.branch_id)`,
      [randomUUID(), e.patientId, e.occurredAt, e.kind, e.refId, e.title, JSON.stringify(e.summary ?? {}), e.doctorId ?? null, e.branchId ?? null]);
  }

  async remove(c: Queryable, kind: Kind, refId: string) {
    await c.query('DELETE FROM timeline_entries WHERE kind = $1 AND ref_id = $2', [kind, refId]);
  }

  /** Newest first, keyset-paginated by (occurred_at, id). */
  async page(actor: Actor, patientId: string, q: { kinds?: Kind[]; before?: { at: string; id: string } }) {
    const c = await this.db.current();
    const d = await this.access.assertCanRead(c, actor, patientId, 'TIMELINE');
    await this.audit.record({ actorId: actor.id, actorKind: actor.kind, actorName: d.actorName, action: 'READ', resourceType: 'TIMELINE', patientId, purpose: d.purpose });
    // a consented doctor sees appointments plus only the kinds the patient shared
    const allowed: Kind[] | null = d.purpose === 'CONSENT' ? ['APPOINTMENT', ...(d.consentScope ?? []).flatMap((s) => KINDS_FOR_SCOPE[s] ?? [])] : null;
    const kinds = q.kinds?.length ? (allowed ? q.kinds.filter((k) => allowed.includes(k)) : q.kinds) : allowed;
    const { rows } = await c.query(
      `SELECT t.*, d.name AS doctor_name FROM timeline_entries t LEFT JOIN doctors d ON d.id = t.doctor_id
       WHERE t.patient_id = $1 AND ($2::text[] IS NULL OR t.kind = ANY($2)) AND ($3::timestamptz IS NULL OR (t.occurred_at, t.id) < ($3, $4::uuid))
       ORDER BY t.occurred_at DESC, t.id DESC LIMIT 30`,
      [patientId, kinds, q.before?.at ?? null, q.before?.id ?? null]);
    const items = rows.map((r) => ({ id: r.id, kind: r.kind, refId: r.ref_id, occurredAt: r.occurred_at, title: r.title, summary: r.summary, doctor: r.doctor_name }));
    const last = rows.at(-1);
    return { items, next: rows.length === 30 ? { at: new Date(last.occurred_at).toISOString(), id: last.id } : null, access: { purpose: d.purpose } };
  }
}
