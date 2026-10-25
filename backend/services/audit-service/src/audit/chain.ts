import { createHash } from 'node:crypto';

export const GENESIS = Buffer.alloc(32);

export interface ChainRow {
  id: string | number; occurred_at: Date | string; source: string; actor_id: string; actor_kind: string; actor_name: string | null;
  action: string; resource_type: string; resource_id: string | null; patient_id: string | null; purpose: string;
  request_id: string | null; ip: string | null; changes: string[] | null;
}

/** Canonical, order-fixed serialisation of everything an entry asserts (incl. its id and time). */
export const canonical = (r: ChainRow) => JSON.stringify([
  String(r.id), new Date(r.occurred_at).toISOString(), r.source, r.actor_id, r.actor_kind, r.actor_name ?? null, r.action, r.resource_type,
  r.resource_id ?? null, r.patient_id ?? null, r.purpose, r.request_id ?? null, r.ip ?? null, r.changes ?? null,
]);

/** hash = SHA-256(prev_hash || canonical row) */
export const chainHash = (prev: Buffer, r: ChainRow) => createHash('sha256').update(prev).update(canonical(r)).digest();
