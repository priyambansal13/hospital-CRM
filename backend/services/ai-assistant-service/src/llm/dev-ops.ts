import type { ToolCall, Turn } from './llm.js';

/**
 * The dev provider's Ops work (Phase 29), deterministic and offline: it reads an admin's question into metric calls
 * (a keyword list over the semantic layer's names), writes the answer only from the tool results, and writes the
 * morning brief and care-gap wording from the facts it is given. Gemini does the real understanding and wording.
 */
const METRICS: [RegExp, string][] = [
  [/no[- ]?show(s)? rate|rate of no[- ]?shows?|no[- ]?show percentage/, 'no_show_rate'],
  [/no[- ]?shows?|did ?n[o']t (come|turn up)/, 'no_shows'],
  [/cancell?ation rate/, 'cancellation_rate'],
  [/cancell?ations?|cancelled/, 'cancellations'],
  [/utili[sz]ation|how full|capacity|occupancy/, 'utilisation'],
  [/refunds?/, 'refunds'],
  [/revenue|income|collections?|collected|money|earn/, 'revenue'],
  [/turnaround|\btat\b|reports? (take|delay)/, 'lab_tat_hours'],
  [/late reports?|reports? late|breach/, 'lab_tat_breach_rate'],
  [/lab orders?|lab tests?/, 'lab_orders'],
  [/new patients?|registrations?|registered/, 'new_patients'],
  [/first visits?/, 'new_patient_visits'],
  [/booked online|online share|self[- ]booked/, 'online_share'],
  [/assistant|ai bookings?|chatbot/, 'assistant_bookings'],
  [/lead time|days? ahead|in advance/, 'avg_lead_days'],
  [/completed|visits? done|consultations? done/, 'completed_visits'],
  [/appointments?|bookings?|visits?|footfall/, 'appointments'],
];
const GROUPS: [RegExp, string][] = [
  [/department|specialt(y|ies)|speciality/, 'specialty'],
  [/doctors?\b/, 'doctor'],
  [/branch(es)?\b/, 'branch'],
  [/weekday|day of (the )?week/, 'weekday'],
  [/hour|time of (the )?day/, 'hour'],
  [/\bmonthly\b|by month|per month|each month/, 'month'],
  [/\bweekly\b|by week|per week|each week/, 'week'],
  [/\bdaily\b|by day\b(?! of)|per day|each day/, 'day'],
  [/channel|how (patients|people) booked/, 'source'],
  [/age/, 'age_band'],
];

const add = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function periodFrom(q: string, today: string): { from: string; to: string } {
  const n = /\b(?:last|past) (\d{1,3}) days\b/.exec(q);
  if (n) return { from: add(today, -(Number(n[1]) - 1)), to: today };
  if (/\blast month\b|\bprevious month\b/.test(q)) { const to = add(`${today.slice(0, 7)}-01`, -1); return { from: `${to.slice(0, 7)}-01`, to }; }
  if (/\bthis month\b/.test(q)) return { from: `${today.slice(0, 7)}-01`, to: today };
  if (/\blast week\b|\bpast week\b/.test(q)) return { from: add(today, -7), to: add(today, -1) };
  if (/\bthis week\b/.test(q)) return { from: add(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7)), to: today };
  if (/\byesterday\b/.test(q)) return { from: add(today, -1), to: add(today, -1) };
  if (/\btoday\b/.test(q)) return { from: today, to: today };
  if (/\bthis year\b/.test(q)) return { from: `${today.slice(0, 4)}-01-01`, to: today };
  return { from: add(today, -29), to: today };
}

/** One step of the Ops agent: the calls a question needs, or the answer from the results. */
export function devOpsStep(system: string, turns: Turn[]): { calls: ToolCall[] } | { text: string } {
  const last = turns.at(-1);
  if (last?.results?.length) return { text: answerFrom(last.results.map((r) => r.response)) };
  const q = (turns.findLast((t) => t.role === 'user' && t.text)?.text ?? '').toLowerCase();
  const today = /<today>(\d{4}-\d{2}-\d{2})<\/today>/.exec(system)?.[1] ?? new Date().toISOString().slice(0, 10);
  const metric = METRICS.find(([re]) => re.test(q))?.[1];
  if (!metric) return { text: 'I can answer questions about appointments, no-shows, cancellations, utilisation, revenue, refunds, lab orders and turnaround, and new patients, by branch, doctor, department or date. What would you like to know?' };
  const { from, to } = periodFrom(q, today);
  const groups = GROUPS.filter(([re]) => re.test(q)).map(([, g]) => g).slice(0, 2);
  const calls = (groups.length ? groups : [undefined]).map((g, i) => ({ id: `dev-${i}`, name: 'query_metric', args: { metric, from, to, ...(g ? { group_by: g } : {}) } }));
  return { calls };
}

interface Res { label?: string; unit?: string; from?: string; to?: string; groupLabel?: string | null; value?: number | null; rows?: { label: string; value: number | null }[]; error?: string }
const fmt = (v: number, unit?: string) => (unit === 'percent' ? `${v}%` : unit === 'inr' ? `₹${v}` : unit === 'hours' ? `${v} hours` : unit === 'days' ? `${v} days` : String(v));

function answerFrom(results: Record<string, unknown>[]): string {
  const parts = (results as Res[]).map((r) => {
    if (r.error) return `I could not get that: ${r.error}`;
    const period = `${r.from} to ${r.to}`;
    if (!r.rows) return `${r.label} from ${period}: ${r.value == null ? 'no data' : fmt(r.value, r.unit)}.`;
    const rows = r.rows.filter((x) => x.value != null) as { label: string; value: number }[];
    if (!rows.length) return `${r.label} by ${r.groupLabel?.toLowerCase()} from ${period}: no data.`;
    const sorted = [...rows].sort((a, b) => b.value - a.value);
    const hi = sorted[0];
    const lo = sorted.at(-1)!;
    return sorted.length === 1
      ? `${r.label} by ${r.groupLabel?.toLowerCase()} from ${period}: only ${hi.label} has data (${fmt(hi.value, r.unit)}).`
      : `${r.label} by ${r.groupLabel?.toLowerCase()} from ${period}: highest ${hi.label} (${fmt(hi.value, r.unit)}), lowest ${lo.label} (${fmt(lo.value, r.unit)}).`;
  });
  return `${parts.join(' ')} The table below has every figure.`;
}

/** The morning brief from its facts (`<brief_facts>` JSON in the prompt). */
export function devBrief(prompt: string): { headline: string; points: string[] } {
  const f = JSON.parse(/<brief_facts>([\s\S]*?)<\/brief_facts>/.exec(prompt)?.[1] ?? '{}');
  const t = f.today ?? {};
  const y = f.yesterdayStats ?? {};
  const points = [
    `Today: ${t.booked ?? 0} appointments booked${t.loadPercent != null ? `, ${t.loadPercent}% of the doctors' time` : ''} with ${t.doctorsWorking ?? 0} doctors working.`,
    `Yesterday: ${y.completed ?? 0} visits completed, ${y.noShows ?? 0} no-shows${y.noShowRate != null ? ` (${y.noShowRate}%)` : ''}, ${y.cancelled ?? 0} cancellations; ₹${y.collected ?? 0} collected.`,
  ];
  if (t.mostFree?.length) points.push(`Free time today: ${t.mostFree.map((d: { name: string; free: number }) => `${d.name} (${d.free} slots)`).join(', ')}.`);
  if (f.lab?.late) points.push(`${f.lab.late} lab reports are past their promised time.`);
  if (f.paymentIssues) points.push(`${f.paymentIssues} payments could not be applied and need a look.`);
  return { headline: `${f.branchName}: ${t.booked ?? 0} appointments today; ${y.noShows ?? 0} no-shows yesterday.`, points };
}

/** A care-gap reminder's wording (`<care_gap_rule>` JSON): placeholders only, never the condition. */
export function devCareGap(prompt: string): { subject: string; body: string } {
  const r = JSON.parse(/<care_gap_rule>([\s\S]*?)<\/care_gap_rule>/.exec(prompt)?.[1] ?? '{}');
  return {
    subject: 'A check-up reminder from {{hospital}}',
    body: `Hello {{patientName}}, it has been a while since your last ${r.testName ?? 'check-up test'}. Your doctor recommends it ${r.every ?? 'regularly'}. You can book it here: {{link}}. – {{hospital}}`,
  };
}
