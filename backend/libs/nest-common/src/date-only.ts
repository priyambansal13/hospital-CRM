/**
 * A Postgres `date` as YYYY-MM-DD. node-pg reads a date as local midnight, so `toISOString()` shifts it a day back
 * wherever the process runs east of UTC (India): format the local parts instead. Strings pass through.
 */
export function dateOnly(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
}
