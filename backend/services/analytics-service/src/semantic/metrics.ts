import { z } from 'zod';

/**
 * The semantic layer (docs/AI-AGENTS.md §6): named metrics over the warehouse, each with the dimensions it may be
 * grouped or filtered by. Dashboards, CSV exports and the Ops agent all ask for metrics by name; nobody (person or
 * model) writes SQL. Every fragment below is a constant: the request only picks names and passes values as parameters.
 */
export type Unit = 'count' | 'percent' | 'inr' | 'hours' | 'days';
export const DIMENSIONS = ['day', 'week', 'month', 'weekday', 'hour', 'branch', 'doctor', 'specialty', 'mode', 'source', 'channel', 'paid_for', 'collection', 'age_band', 'gender', 'campaign'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const TIME_DIMS: Dimension[] = ['day', 'week', 'month', 'weekday', 'hour'];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  day: 'Day', week: 'Week', month: 'Month', weekday: 'Day of the week', hour: 'Hour of the day', branch: 'Branch', doctor: 'Doctor',
  specialty: 'Department (specialty)', mode: 'Visit type', source: 'Booking channel', channel: 'Payment channel', paid_for: 'Paid for',
  collection: 'Sample collection', age_band: 'Age group', gender: 'Gender', campaign: 'Campaign link',
};

interface Fact {
  from: string;
  date: string;
  /** null: the fact has no branch (hospital-wide only) */
  branch: string | null;
  dims: Partial<Record<Dimension, string>>;
}

const time = (d: string): Partial<Record<Dimension, string>> => ({
  day: `to_char(${d}, 'YYYY-MM-DD')`, week: `to_char(date_trunc('week', ${d}), 'YYYY-MM-DD')`, month: `to_char(${d}, 'YYYY-MM')`,
  weekday: `extract(isodow FROM ${d})::int::text`,
});

export const FACTS = {
  appointments: {
    from: 'fact_appointments f', date: 'f.local_date', branch: 'f.branch_id',
    dims: { ...time('f.local_date'), hour: `lpad(f.hour::text, 2, '0')`, branch: 'f.branch_id::text', doctor: 'f.doctor_id::text', specialty: 'f.specialty_code',
      mode: 'f.mode', source: `CASE WHEN f.booked_via = 'ASSISTANT' THEN 'ASSISTANT' ELSE f.source END`,
      // the hospital's own campaign links (online bookings); everything else is "(none)"
      campaign: `coalesce(f.campaign, '(none)')` },
  },
  lab: {
    from: 'fact_lab_orders f', date: 'f.local_date', branch: 'f.branch_id',
    dims: { ...time('f.local_date'), branch: 'f.branch_id::text', collection: 'f.collection_type' },
  },
  payments: {
    from: 'fact_payments f', date: 'f.local_date', branch: 'f.branch_id',
    dims: { ...time('f.local_date'), branch: 'f.branch_id::text', channel: 'f.channel', paid_for: 'f.source_type' },
  },
  patients: {
    from: 'fact_patients f', date: 'f.local_date', branch: null,
    dims: { ...time('f.local_date'), age_band: 'f.age_band', gender: 'f.gender' },
  },
  capacity: {
    from: 'fact_capacity f', date: 'f.local_date', branch: 'f.branch_id',
    dims: { ...time('f.local_date'), branch: 'f.branch_id::text', doctor: 'f.doctor_id::text', specialty: '(SELECT d.specialty_codes[1] FROM dim_doctors d WHERE d.id = f.doctor_id)' },
  },
} satisfies Record<string, Fact>;
type FactKey = keyof typeof FACTS;

export interface Metric {
  label: string;
  description: string;
  fact: FactKey;
  expr: string;
  unit: Unit;
  /** which way is good (dashboards colour the change) */
  better: 'up' | 'down';
}

const BOOKED = `f.status NOT IN ('RESCHEDULED','EXPIRED','PENDING_PAYMENT')`;
const DUE = `f.status IN ('COMPLETED','NO_SHOW','CHECKED_IN','IN_PROGRESS')`;
const pct = (num: string, den: string) => `round(100.0 * count(*) FILTER (WHERE ${num}) / nullif(count(*) FILTER (WHERE ${den}), 0), 1)`;

export const METRICS = {
  appointments: { label: 'Appointments', description: 'Appointments booked for the period (by visit date), excluding moved, expired and unpaid holds', fact: 'appointments', expr: `count(*) FILTER (WHERE ${BOOKED})`, unit: 'count', better: 'up' },
  completed_visits: { label: 'Completed visits', description: 'Visits the doctor completed', fact: 'appointments', expr: `count(*) FILTER (WHERE f.status = 'COMPLETED')`, unit: 'count', better: 'up' },
  no_shows: { label: 'No-shows', description: 'Booked patients who did not come', fact: 'appointments', expr: `count(*) FILTER (WHERE f.status = 'NO_SHOW')`, unit: 'count', better: 'down' },
  no_show_rate: { label: 'No-show rate', description: 'No-shows as a share of visits that were due (came or did not come)', fact: 'appointments', expr: pct(`f.status = 'NO_SHOW'`, DUE), unit: 'percent', better: 'down' },
  cancellations: { label: 'Cancellations', description: 'Appointments cancelled by the patient or the hospital', fact: 'appointments', expr: `count(*) FILTER (WHERE f.status = 'CANCELLED')`, unit: 'count', better: 'down' },
  cancellation_rate: { label: 'Cancellation rate', description: 'Cancelled as a share of appointments booked', fact: 'appointments', expr: pct(`f.status = 'CANCELLED'`, BOOKED), unit: 'percent', better: 'down' },
  online_share: { label: 'Booked online', description: 'Share of appointments patients booked themselves (website, app or AI assistant)', fact: 'appointments', expr: pct(`f.source = 'ONLINE'`, BOOKED), unit: 'percent', better: 'up' },
  assistant_bookings: { label: 'Booked by the AI assistant', description: 'Appointments booked through the AI assistant', fact: 'appointments', expr: `count(*) FILTER (WHERE f.booked_via = 'ASSISTANT' AND ${BOOKED})`, unit: 'count', better: 'up' },
  new_patient_visits: { label: 'First visits', description: 'Appointments that were the patient\'s first visit', fact: 'appointments', expr: `count(*) FILTER (WHERE f.first_visit AND ${BOOKED})`, unit: 'count', better: 'up' },
  avg_lead_days: { label: 'Days booked ahead', description: 'Average days between booking and the visit (walk-ins excluded)', fact: 'appointments', expr: `round(avg(f.lead_days) FILTER (WHERE ${BOOKED} AND f.source <> 'WALK_IN'), 1)`, unit: 'days', better: 'up' },
  utilisation: { label: 'Utilisation', description: 'Booked time as a share of the doctors\' bookable time', fact: 'capacity', expr: `round(100.0 * sum(f.booked) / nullif(sum(f.slots), 0), 1)`, unit: 'percent', better: 'up' },
  capacity_slots: { label: 'Bookable slots', description: 'Appointment slots the doctors offered', fact: 'capacity', expr: `sum(f.slots)::int`, unit: 'count', better: 'up' },
  revenue: { label: 'Revenue (net)', description: 'Money collected (online and at the counter) minus refunds, by the day it moved', fact: 'payments', expr: `coalesce(sum(f.amount), 0)`, unit: 'inr', better: 'up' },
  refunds: { label: 'Refunds', description: 'Money paid back to patients', fact: 'payments', expr: `coalesce(-sum(f.amount) FILTER (WHERE f.kind = 'REFUND'), 0)`, unit: 'inr', better: 'down' },
  lab_orders: { label: 'Lab orders', description: 'Lab orders placed (cancelled and expired excluded)', fact: 'lab', expr: `count(*) FILTER (WHERE f.status NOT IN ('CANCELLED','EXPIRED'))`, unit: 'count', better: 'up' },
  lab_tat_hours: { label: 'Lab turnaround (median)', description: 'Median hours from the sample reaching the lab to the published report', fact: 'lab',
    expr: `round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM f.published_at - coalesce(f.in_lab_at, f.collected_at)) / 3600) FILTER (WHERE f.published_at IS NOT NULL AND coalesce(f.in_lab_at, f.collected_at) IS NOT NULL))::numeric, 1)`, unit: 'hours', better: 'down' },
  lab_tat_breach_rate: { label: 'Reports late', description: 'Share of orders in the lab that went past their promised turnaround time', fact: 'lab', expr: pct('f.tat_breached', 'f.in_lab_at IS NOT NULL OR f.tat_breached'), unit: 'percent', better: 'down' },
  new_patients: { label: 'New patients', description: 'Patients registered (hospital-wide)', fact: 'patients', expr: 'count(*)', unit: 'count', better: 'up' },
} satisfies Record<string, Metric>;
export type MetricKey = keyof typeof METRICS;

export const MAX_DAYS = 400;
const date = z.iso.date();
export const MetricQuery = z.object({
  metric: z.enum(Object.keys(METRICS) as [MetricKey, ...MetricKey[]]),
  from: date,
  to: date,
  groupBy: z.enum(DIMENSIONS).optional(),
  filters: z.object({ branchId: z.uuid().optional(), doctorId: z.uuid().optional(), specialty: z.string().max(40).optional() }).default({}),
  limit: z.number().int().min(1).max(100).default(50),
}).refine((q) => q.from <= q.to, { message: 'from must not be after to' })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= MAX_DAYS, { message: `at most ${MAX_DAYS} days at a time` });
export type MetricQuery = z.infer<typeof MetricQuery>;

export class MetricError extends Error {
  constructor(readonly code: 'DIMENSION_NOT_AVAILABLE' | 'FILTER_NOT_AVAILABLE' | 'HOSPITAL_WIDE_ONLY', message: string) { super(message); }
}

/** Which dimensions a metric can be grouped by. */
export const dimensionsOf = (m: MetricKey): Dimension[] => Object.keys(FACTS[METRICS[m].fact].dims) as Dimension[];

/**
 * Metric query → SQL with parameters. `branches` null = every branch, otherwise the person's branches (always
 * applied; a hospital-wide fact refuses a branch-limited person).
 */
export function compile(q: MetricQuery, branches: string[] | null): { sql: string; args: unknown[] } {
  const m: Metric = METRICS[q.metric];
  const f: Fact = FACTS[m.fact];
  const args: unknown[] = [q.from, q.to];
  const where = [`${f.date} BETWEEN $1::date AND $2::date`];
  const add = (v: unknown) => { args.push(v); return `$${args.length}`; };
  if (branches !== null) {
    if (!f.branch) throw new MetricError('HOSPITAL_WIDE_ONLY', `${m.label} is counted for the whole hospital; ask a hospital admin`);
    where.push(`${f.branch} = ANY(${add(branches)}::uuid[])`);
  }
  if (q.filters.branchId) {
    if (!f.branch) throw new MetricError('FILTER_NOT_AVAILABLE', `${m.label} cannot be filtered by branch`);
    where.push(`${f.branch} = ${add(q.filters.branchId)}::uuid`);
  }
  if (q.filters.doctorId) {
    if (!f.dims.doctor) throw new MetricError('FILTER_NOT_AVAILABLE', `${m.label} cannot be filtered by doctor`);
    where.push(`${f.dims.doctor} = ${add(q.filters.doctorId)}`);
  }
  if (q.filters.specialty) {
    if (!f.dims.specialty) throw new MetricError('FILTER_NOT_AVAILABLE', `${m.label} cannot be filtered by department`);
    where.push(`${f.dims.specialty} = ${add(q.filters.specialty)}`);
  }
  if (!q.groupBy) return { sql: `SELECT ${m.expr} AS v FROM ${f.from} WHERE ${where.join(' AND ')}`, args };
  const dim = f.dims[q.groupBy];
  if (!dim) throw new MetricError('DIMENSION_NOT_AVAILABLE', `${m.label} cannot be split by ${DIMENSION_LABELS[q.groupBy].toLowerCase()}; try ${dimensionsOf(q.metric).join(', ')}`);
  // a time series is never cut short (at most MAX_DAYS + 1 days); other splits show the top `limit`
  const series = TIME_DIMS.includes(q.groupBy);
  return { sql: `SELECT ${dim} AS k, ${m.expr} AS v FROM ${f.from} WHERE ${where.join(' AND ')} GROUP BY 1 ORDER BY ${series ? 'k' : 'v DESC NULLS LAST, k'} LIMIT ${series ? MAX_DAYS + 1 : q.limit}`, args };
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LABELS: Record<string, string> = {
  ONLINE: 'Online', DESK: 'Front desk', WALK_IN: 'Walk-in', ASSISTANT: 'AI assistant', COUNTER: 'At the counter', IN_PERSON: 'In person', VIDEO: 'Video',
  APPOINTMENT: 'Consultations', LAB_ORDER: 'Lab tests', MEMBERSHIP: 'Memberships', AT_LAB: 'At the lab', HOME: 'Home collection',
  MALE: 'Male', FEMALE: 'Female', OTHER: 'Other',
};

/** Fills the gaps of a day / weekday / hour series (zero for counts and money; rates stay empty). */
export function fill(q: MetricQuery, rows: { key: string; value: number | null }[]): { key: string; value: number | null }[] {
  const unit = METRICS[q.metric].unit;
  const zero = unit === 'count' || unit === 'inr' ? 0 : null;
  const have = new Map(rows.map((r) => [r.key, r.value]));
  let keys: string[] | null = null;
  if (q.groupBy === 'weekday') keys = ['1', '2', '3', '4', '5', '6', '7'];
  if (q.groupBy === 'day' && (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92) {
    keys = [];
    for (let t = Date.parse(`${q.from}T00:00:00Z`); t <= Date.parse(`${q.to}T00:00:00Z`); t += 86_400_000) keys.push(new Date(t).toISOString().slice(0, 10));
  }
  return keys ? keys.map((k) => ({ key: k, value: have.has(k) ? have.get(k)! : zero })) : rows;
}

/** A readable label for a group key (names of branches, doctors and departments come from the dimension tables). */
export function labelOf(dim: Dimension | undefined, key: string | null, names: Map<string, string>): string {
  if (key == null) return 'Not recorded';
  if (dim === 'weekday') return WEEKDAYS[Number(key) - 1] ?? key;
  if (dim === 'hour') return `${key}:00`;
  if (dim === 'branch' || dim === 'doctor' || dim === 'specialty') return names.get(key) ?? (dim === 'specialty' ? key : 'Unknown');
  return LABELS[key] ?? key;
}
