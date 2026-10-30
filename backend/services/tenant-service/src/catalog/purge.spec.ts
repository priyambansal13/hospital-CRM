import { describe, expect, it } from 'vitest';
import { assertPurgeable } from './provisioning.service.js';

const now = new Date('2026-12-01T00:00:00Z');
const o = { now, days: 30, force: false, dev: false };

describe('purge guard (review H-1)', () => {
  it('never purges a hospital that is not deleted', () => {
    for (const status of ['ACTIVE', 'READ_ONLY', 'SUSPENDED']) expect(() => assertPurgeable({ status, deleted_at: null }, o)).toThrow(/only a deleted hospital/);
    expect(() => assertPurgeable({ status: 'ACTIVE', deleted_at: '2020-01-01' }, { ...o, force: true, dev: true })).toThrow(/only a deleted hospital/);
  });

  it('keeps a deleted hospital for the retention period', () => {
    expect(() => assertPurgeable({ status: 'DELETED', deleted_at: '2026-11-20T00:00:00Z' }, o)).toThrow(/kept until 2026-12-20/);
    expect(() => assertPurgeable({ status: 'DELETED', deleted_at: '2026-10-01T00:00:00Z' }, o)).not.toThrow();
  });

  it('force skips the retention period in development only', () => {
    const recent = { status: 'DELETED', deleted_at: '2026-11-30T00:00:00Z' };
    expect(() => assertPurgeable(recent, { ...o, force: true, dev: false })).toThrow(/kept until/);
    expect(() => assertPurgeable(recent, { ...o, force: true, dev: true })).not.toThrow();
  });
});
