import { describe, expect, it } from 'vitest';
import { type ChainRow, chainHash, GENESIS } from './chain.js';

const row = (id: number, patch: Partial<ChainRow> = {}): ChainRow => ({
  id, occurred_at: new Date(Date.UTC(2026, 9, 24, 5, 0, id)), source: 'records-service', actor_id: 'u1', actor_kind: 'staff', actor_name: 'Dr. A',
  action: 'READ', resource_type: 'CHART', resource_id: null, patient_id: '11111111-1111-4111-8111-111111111111', purpose: 'TREATMENT',
  request_id: 'r1', ip: null, changes: null, ...patch,
});

describe('audit hash chain', () => {
  it('links each entry to the previous one', () => {
    const h1 = chainHash(GENESIS, row(1));
    const h2 = chainHash(h1, row(2));
    expect(h1).toHaveLength(32);
    expect(chainHash(h1, row(2)).equals(h2)).toBe(true);
    expect(chainHash(GENESIS, row(2)).equals(h2)).toBe(false); // same row, other position → other hash
  });
  it('any changed field changes the hash', () => {
    const base = chainHash(GENESIS, row(1));
    for (const patch of [{ actor_id: 'u2' }, { action: 'UPDATE' }, { purpose: 'BREAK_GLASS' }, { occurred_at: new Date(0) }, { patient_id: null }, { changes: ['notes'] }]) {
      expect(chainHash(GENESIS, row(1, patch)).equals(base)).toBe(false);
    }
  });
  it('time is compared at millisecond precision whatever form it arrives in', () => {
    const d = new Date('2026-10-24T05:00:01.123Z');
    expect(chainHash(GENESIS, row(1, { occurred_at: d })).equals(chainHash(GENESIS, row(1, { occurred_at: d.toISOString() })))).toBe(true);
  });
});
