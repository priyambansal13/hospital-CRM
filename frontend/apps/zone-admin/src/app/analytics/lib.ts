/** Analytics page helpers (periods in India time, number formatting by unit). */
export type Unit = 'count' | 'percent' | 'inr' | 'hours' | 'days';
export interface MetricResult {
  metric: string; label: string; unit: Unit; from: string; to: string; groupBy: string | null; groupLabel: string | null;
  value: number | null; rows: { key: string | null; label: string; value: number | null }[];
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const add = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const PERIODS = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
] as const;

export function periodOf(key: string | undefined) {
  const t = today();
  const p = PERIODS.find((x) => x.key === key) ?? PERIODS[1];
  let from: string; let to = t;
  if (p.key === 'month') from = `${t.slice(0, 7)}-01`;
  else if (p.key === 'last-month') { to = add(`${t.slice(0, 7)}-01`, -1); from = `${to.slice(0, 7)}-01`; }
  else from = add(t, -(Number(p.key.replace('d', '')) - 1));
  return { key: p.key, label: p.label, from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 };
}

export function fmt(v: number | null | undefined, unit: Unit): string {
  if (v == null) return '—';
  const n = new Intl.NumberFormat('en-IN', { maximumFractionDigits: unit === 'count' ? 0 : 1 }).format(v);
  return unit === 'percent' ? `${n}%` : unit === 'inr' ? `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v)}` : unit === 'hours' ? `${n} h` : unit === 'days' ? `${n} days` : n;
}
