import { Injectable } from '@nestjs/common';
import type { AuditEntry } from '@mc/contracts';
import { type Queryable, TenantDbRouter } from '@mc/tenancy';
import { type ChainRow, chainHash, GENESIS } from './chain.js';

@Injectable()
export class AuditService {
  constructor(private readonly db: TenantDbRouter) {}

  /**
   * Append entries to this hospital's chain. One writer at a time per hospital (advisory lock), so the chain is a
   * single line: read the last hash, then number, timestamp, hash and insert each entry.
   */
  async append(source: string, entries: AuditEntry[]): Promise<string[]> {
    return this.db.tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('audit-chain'))`);
      const { rows: last } = await c.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
      let prev: Buffer = last[0]?.hash ?? GENESIS;
      const ids: string[] = [];
      for (const e of entries) {
        const { rows: [{ id }] } = await c.query(`SELECT nextval('audit_log_id_seq')::text AS id`);
        const r: ChainRow = {
          id, occurred_at: new Date(), source, actor_id: e.actorId, actor_kind: e.actorKind, actor_name: e.actorName, action: e.action,
          resource_type: e.resourceType, resource_id: e.resourceId, patient_id: e.patientId, purpose: e.purpose,
          request_id: e.requestId, ip: e.ip, changes: e.changes,
        };
        const hash = chainHash(prev, r);
        await c.query(
          `INSERT INTO audit_log (id, occurred_at, source, actor_id, actor_kind, actor_name, action, resource_type, resource_id, patient_id, purpose, request_id, ip, changes, prev_hash, hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [r.id, r.occurred_at, r.source, r.actor_id, r.actor_kind, r.actor_name, r.action, r.resource_type, r.resource_id, r.patient_id, r.purpose, r.request_id, r.ip,
            r.changes ? JSON.stringify(r.changes) : null, prev, hash]);
        ids.push(id);
        prev = hash;
      }
      return ids;
    });
  }

  /** Walk the whole chain: every entry's prev_hash must be the previous hash, and its hash must match its content. */
  async verify(c: Queryable): Promise<{ ok: boolean; checked: number; firstBrokenId: string | null; problem: string | null }> {
    let prev: Buffer = GENESIS;
    let after = '0';
    let checked = 0;
    for (;;) {
      const { rows } = await c.query('SELECT * FROM audit_log WHERE id > $1 ORDER BY id LIMIT 2000', [after]);
      if (!rows.length) return { ok: true, checked, firstBrokenId: null, problem: null };
      for (const r of rows) {
        if (!r.prev_hash.equals(prev)) return { ok: false, checked, firstBrokenId: String(r.id), problem: 'an entry before it was removed or changed' };
        if (!chainHash(prev, r).equals(r.hash)) return { ok: false, checked, firstBrokenId: String(r.id), problem: 'this entry was changed after it was written' };
        prev = r.hash;
        checked++;
        after = String(r.id);
      }
    }
  }
}

export const toEntry = (r: any) => ({
  id: String(r.id), occurredAt: r.occurred_at, source: r.source, actor: { id: r.actor_id, kind: r.actor_kind, name: r.actor_name },
  action: r.action, resourceType: r.resource_type, resourceId: r.resource_id, patientId: r.patient_id, purpose: r.purpose,
  requestId: r.request_id, changes: r.changes,
});
