import { HttpPlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { GENERATE_SLOTS } from '../src/schedule/slots.sql.js';

const placements = new HttpPlacementSource();
const router = new TenantDbRouter(placements, 'scheduling');
afterAll(() => router.close());

/** Runs fn in a transaction on sunrise's database and always rolls back (no test data left behind). */
async function inRolledBackTx(fn: (c: any) => Promise<void>) {
  const t = await placements.resolveHost('sunrise.localhost');
  await TenantContext.run(t, async () => {
    const c = await (await router.current()).connect();
    try {
      await c.query('BEGIN');
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
}

async function seed(c: any, timezone: string, day: number, start: string, end: string, minutes: number) {
  const doctor = randomUUID();
  const branch = randomUUID();
  await c.query('INSERT INTO branches (id, name, timezone, active) VALUES ($1, $2, $3, true)', [branch, 'Test', timezone]);
  await c.query('INSERT INTO doctors (id, name, status, branch_ids) VALUES ($1, $2, $3, $4)', [doctor, 'Dr. T', 'ACTIVE', [branch]]);
  await c.query(
    `INSERT INTO availability_templates (id, doctor_id, branch_id, day_of_week, start_time, end_time, slot_minutes, mode, effective_from, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'IN_PERSON', current_date - 1, $2)`,
    [randomUUID(), doctor, branch, day, start, end, minutes],
  );
  return doctor;
}

describe('slot generation', () => {
  it('creates slots at the branch-local wall-clock time (IST: 10:00 local = 04:30 UTC)', async () => {
    await inRolledBackTx(async (c) => {
      const doctor = await seed(c, 'Asia/Kolkata', 1, '10:00', '13:00', 15);
      const r = await c.query(GENERATE_SLOTS, [doctor, 21]);
      expect(r.rowCount).toBeGreaterThanOrEqual(24); // >= 2 Mondays × 12 slots
      const { rows } = await c.query(`SELECT to_char(starts_at AT TIME ZONE 'UTC', 'HH24:MI') utc, to_char(starts_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') local,
        extract(isodow FROM starts_at AT TIME ZONE 'Asia/Kolkata')::int dow FROM slots WHERE doctor_id = $1 ORDER BY starts_at LIMIT 12`, [doctor]);
      expect(rows[0]).toEqual({ utc: '04:30', local: '10:00', dow: 1 });
      expect(rows.at(-1).local).toBe('12:45');
      expect(new Set(rows.map((x: any) => x.dow))).toEqual(new Set([1]));
    });
  });

  it('follows daylight saving: 09:00 New York is 13:00 UTC in summer and 14:00 UTC in winter', async () => {
    await inRolledBackTx(async (c) => {
      const doctor = await seed(c, 'America/New_York', 7, '09:00', '09:30', 30);
      // horizon long enough to cross a DST change in either direction
      await c.query(GENERATE_SLOTS, [doctor, 200]);
      const { rows } = await c.query(`SELECT DISTINCT to_char(starts_at AT TIME ZONE 'America/New_York', 'HH24:MI') local, to_char(starts_at AT TIME ZONE 'UTC', 'HH24:MI') utc FROM slots WHERE doctor_id = $1`, [doctor]);
      expect(new Set(rows.map((x: any) => x.local))).toEqual(new Set(['09:00']));
      expect(new Set(rows.map((x: any) => x.utc))).toEqual(new Set(['13:00', '14:00']));
    });
  });

  it('is idempotent and marks leave days BLOCKED', async () => {
    await inRolledBackTx(async (c) => {
      const doctor = await seed(c, 'Asia/Kolkata', 2, '09:00', '10:00', 20);
      await c.query(`INSERT INTO doctor_leaves (id, doctor_id, from_date, to_date, created_by) VALUES ($1, $2, current_date, current_date + 6, $2)`, [randomUUID(), doctor]);
      const first = await c.query(GENERATE_SLOTS, [doctor, 14]);
      const again = await c.query(GENERATE_SLOTS, [doctor, 14]);
      expect(again.rowCount).toBe(0);
      const { rows } = await c.query(`SELECT status, count(*)::int n FROM slots WHERE doctor_id = $1 GROUP BY status`, [doctor]);
      const by = Object.fromEntries(rows.map((r: any) => [r.status, r.n]));
      expect(by.BLOCKED).toBeGreaterThan(0);
      expect((by.BLOCKED ?? 0) + (by.OPEN ?? 0)).toBe(first.rowCount);
    });
  });
});
