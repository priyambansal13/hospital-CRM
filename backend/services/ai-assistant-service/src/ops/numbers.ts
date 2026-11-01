/**
 * The Ops agent's and the brief's number check (like the copilot's citation check): every number the model writes
 * must come from the data it was given (tool results or the brief's facts), as given or rounded. Dates and counts of
 * rows are in the data too, so they pass; an invented or miscalculated figure does not.
 */
const NUM = /\d[\d,]*(?:\.\d+)?/g;
const norm = (s: string) => Number(s.replace(/,/g, ''));

export function allowedNumbers(data: unknown): Set<number> {
  const out = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 24, 30, 100]);
  const add = (n: number) => { if (!Number.isFinite(n)) return; out.add(n); out.add(Math.round(n)); out.add(Math.round(n * 10) / 10); };
  const walk = (v: unknown) => {
    if (typeof v === 'number') add(v);
    else if (typeof v === 'string') for (const m of v.match(NUM) ?? []) add(norm(m));
    else if (Array.isArray(v)) { add(v.length); v.forEach(walk); }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(data);
  return out;
}

/** Numbers in `text` that the data does not contain. */
export function unknownNumbers(text: string, allowed: Set<number>): string[] {
  return (text.match(NUM) ?? []).filter((m) => !allowed.has(norm(m)));
}
