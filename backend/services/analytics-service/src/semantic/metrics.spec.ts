import { describe, expect, it } from 'vitest';
import { compile, fill, labelOf, MetricQuery } from './metrics.js';

const q = (o: Record<string, unknown>) => MetricQuery.parse({ from: '2026-10-01', to: '2026-10-31', ...o });

describe('semantic layer', () => {
  it('compiles a grouped metric with values as parameters only', () => {
    const { sql, args } = compile(q({ metric: 'no_show_rate', groupBy: 'weekday', filters: { specialty: "DERM'; DROP TABLE x;--" } }), null);
    expect(sql).toContain('FROM fact_appointments f');
    expect(sql).toContain('GROUP BY 1 ORDER BY k');
    expect(sql).not.toContain('DROP TABLE');
    expect(args).toEqual(['2026-10-01', '2026-10-31', "DERM'; DROP TABLE x;--"]);
  });

  it('always limits a branch admin to their branches', () => {
    const b = ['8f0c4c49-3d5e-4a39-9a7f-1d1b1f1b1b1b'];
    const { sql, args } = compile(q({ metric: 'revenue', groupBy: 'channel' }), b);
    expect(sql).toContain('f.branch_id = ANY($3::uuid[])');
    expect(args[2]).toEqual(b);
  });

  it('refuses hospital-wide facts to branch admins and unknown splits', () => {
    expect(() => compile(q({ metric: 'new_patients' }), ['8f0c4c49-3d5e-4a39-9a7f-1d1b1f1b1b1b'])).toThrow(/whole hospital/);
    expect(() => compile(q({ metric: 'revenue', groupBy: 'doctor' }), null)).toThrow(/cannot be split/);
    expect(() => MetricQuery.parse({ metric: 'drop_tables', from: '2026-10-01', to: '2026-10-02' })).toThrow();
    expect(() => MetricQuery.parse({ metric: 'revenue', from: '2024-01-01', to: '2026-10-02' })).toThrow(/400 days/);
    expect(() => MetricQuery.parse({ metric: 'revenue', from: '2026-10-01', to: '2026-10-31', groupBy: 'f.status; --' })).toThrow();
  });

  it('fills gaps in time series (zero for counts, empty for rates) and labels groups', () => {
    const counts = fill(q({ metric: 'appointments', groupBy: 'weekday' }), [{ key: '3', value: 4 }]);
    expect(counts.map((r) => r.value)).toEqual([0, 0, 4, 0, 0, 0, 0]);
    const rates = fill(q({ metric: 'no_show_rate', groupBy: 'day', from: '2026-10-01', to: '2026-10-03' }), [{ key: '2026-10-02', value: 12.5 }]);
    expect(rates).toEqual([{ key: '2026-10-01', value: null }, { key: '2026-10-02', value: 12.5 }, { key: '2026-10-03', value: null }]);
    expect(labelOf('weekday', '1', new Map())).toBe('Mon');
    expect(labelOf('source', 'ASSISTANT', new Map())).toBe('AI assistant');
    expect(labelOf('branch', 'x', new Map([['x', 'Main']]))).toBe('Main');
  });
});
