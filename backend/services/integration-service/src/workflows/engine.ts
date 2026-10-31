import { z } from 'zod';

/**
 * Workflow rules (Phase 27): when <trigger> happens and every condition holds, do the actions. Triggers, the facts a
 * condition can test, and the actions are a fixed list: hospitals configure, they never write code.
 */
export type FactType = 'number' | 'text' | 'choice';
export interface FactDef { label: string; type: FactType; options?: string[] }

const APPT_FACTS: Record<string, FactDef> = {
  noShows: { label: 'Missed visits (patient, all time)', type: 'number' },
  cancellations: { label: 'Cancelled visits (patient, all time)', type: 'number' },
  completedVisits: { label: 'Completed visits (patient, all time)', type: 'number' },
  doctorName: { label: 'Doctor', type: 'text' },
  branchName: { label: 'Branch', type: 'text' },
  mode: { label: 'Visit type', type: 'choice', options: ['IN_PERSON', 'VIDEO'] },
  source: { label: 'Booked by', type: 'choice', options: ['ONLINE', 'DESK', 'WALK_IN'] },
  paymentMode: { label: 'Payment', type: 'choice', options: ['ONLINE', 'AT_CLINIC'] },
  fee: { label: 'Fee (₹)', type: 'number' },
};
const PATIENT_FACTS: Record<string, FactDef> = { tags: { label: 'Patient tags', type: 'text' } };

export const TRIGGERS = {
  APPOINTMENT_BOOKED: { label: 'An appointment is booked', event: 'scheduling.appointment_booked', facts: APPT_FACTS },
  APPOINTMENT_CANCELLED: { label: 'An appointment is cancelled', event: 'scheduling.appointment_cancelled', facts: APPT_FACTS },
  APPOINTMENT_NO_SHOW: { label: 'A patient misses a visit (no-show)', event: 'scheduling.appointment_no_show', facts: APPT_FACTS },
  APPOINTMENT_COMPLETED: { label: 'A visit is completed', event: 'scheduling.appointment_completed', facts: APPT_FACTS },
  LAB_CRITICAL_VALUE: { label: 'A lab result is critical', event: 'diagnostics.critical_value', facts: { testName: { label: 'Test', type: 'text' }, parameter: { label: 'Parameter', type: 'text' } } },
  LAB_REPORT_PUBLISHED: { label: 'A lab report is published', event: 'diagnostics.report_published', facts: { abnormalCount: { label: 'Abnormal values', type: 'number' }, criticalCount: { label: 'Critical values', type: 'number' } } },
  PATIENT_REGISTERED: { label: 'A new patient is registered', event: 'patient.registered', facts: { age: { label: 'Age (years)', type: 'number' }, gender: { label: 'Gender', type: 'choice', options: ['FEMALE', 'MALE', 'OTHER'] } } },
} as const satisfies Record<string, { label: string; event: string; facts: Record<string, FactDef> }>;
export type Trigger = keyof typeof TRIGGERS;
export const triggerOf = (eventType: string) => (Object.keys(TRIGGERS) as Trigger[]).filter((k) => TRIGGERS[k].event === eventType);
/** every trigger also sees the patient's tags and custom fields (`field.<key>`) */
export const factsFor = (t: Trigger): Record<string, FactDef> => ({ ...TRIGGERS[t].facts, ...PATIENT_FACTS });

/** who a staff notice goes to: a permission (held at the event's branch when there is one) */
export const STAFF_AUDIENCES = {
  'appointment:checkin:branch': 'Front desk',
  'critical:escalation:branch': 'Branch admin (on call)',
  'report:verify:branch': 'Pathologists',
  'visit:manage:branch': 'Nurses and visit managers',
  'staff:manage:tenant': 'Hospital admins',
} as const;

export const Condition = z.object({
  fact: z.string().regex(/^([a-zA-Z]+|field\.[a-z][a-z0-9_]{1,39})$/),
  op: z.enum(['eq', 'neq', 'gte', 'lte', 'contains', 'set', 'not_set']),
  value: z.string().trim().max(100).default(''),
});
export type Condition = z.infer<typeof Condition>;
const Text = (max: number) => z.string().trim().min(1).max(max);
export const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('NOTIFY_STAFF'), audience: z.enum(Object.keys(STAFF_AUDIENCES) as [keyof typeof STAFF_AUDIENCES]), subject: Text(150), message: Text(1000) }),
  z.object({ type: z.literal('NOTIFY_PATIENT'), subject: Text(150), message: Text(600) }),
  z.object({ type: z.literal('TAG_PATIENT'), tag: Text(40) }),
  z.object({ type: z.literal('REQUIRE_PREPAYMENT'), reason: Text(200) }),
  z.object({ type: z.literal('CLEAR_PREPAYMENT') }),
]);
export type Action = z.infer<typeof Action>;
export const ACTION_LABELS: Record<Action['type'], string> = {
  NOTIFY_STAFF: 'E-mail staff', NOTIFY_PATIENT: 'Message the patient', TAG_PATIENT: 'Tag the patient',
  REQUIRE_PREPAYMENT: 'Ask the patient to pay online when booking', CLEAR_PREPAYMENT: 'Stop asking the patient to pay online',
};

export const RuleInput = z.object({
  name: Text(80), trigger: z.enum(Object.keys(TRIGGERS) as [Trigger]),
  conditions: z.array(Condition).max(5).default([]), actions: z.array(Action).min(1).max(4),
}).superRefine((r, ctx) => {
  const facts = factsFor(r.trigger);
  r.conditions.forEach((c, i) => {
    if (!c.fact.startsWith('field.') && !facts[c.fact]) ctx.addIssue({ code: 'custom', path: ['conditions', i, 'fact'], message: `"${c.fact}" is not available for this trigger` });
    if (!['set', 'not_set'].includes(c.op) && c.value === '') ctx.addIssue({ code: 'custom', path: ['conditions', i, 'value'], message: 'a value is needed' });
    if (['gte', 'lte'].includes(c.op) && !Number.isFinite(Number(c.value))) ctx.addIssue({ code: 'custom', path: ['conditions', i, 'value'], message: 'compare with a number' });
  });
});
export type RuleInput = z.infer<typeof RuleInput>;

export type Facts = Record<string, string | number | boolean | string[] | null | undefined>;

const norm = (v: unknown) => (v == null ? '' : String(v).trim().toLowerCase());
/** One condition against the facts. Text compares ignore case; lists (tags) "equal" a value when they contain it. */
export function holds(c: Condition, facts: Facts): boolean {
  const v = facts[c.fact];
  const isSet = !(v == null || v === '' || (Array.isArray(v) && v.length === 0));
  switch (c.op) {
    case 'set': return isSet;
    case 'not_set': return !isSet;
    case 'gte': case 'lte': {
      const n = Number(v), w = Number(c.value);
      if (!isSet || !Number.isFinite(n) || !Number.isFinite(w)) return false;
      return c.op === 'gte' ? n >= w : n <= w;
    }
    case 'eq': case 'neq': {
      const eq = Array.isArray(v) ? v.some((x) => norm(x) === norm(c.value)) : (Number.isFinite(Number(v)) && Number.isFinite(Number(c.value)) && isSet ? Number(v) === Number(c.value) : norm(v) === norm(c.value));
      return c.op === 'eq' ? eq : !eq;
    }
    case 'contains': return Array.isArray(v) ? v.some((x) => norm(x).includes(norm(c.value))) : norm(v).includes(norm(c.value));
  }
}
export const allHold = (cs: Condition[], facts: Facts) => cs.every((c) => holds(c, facts));

/** `{{name}}` placeholders from the facts and message variables; unknown ones become empty. */
export const render = (template: string, vars: Record<string, unknown>) =>
  template.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (_, k: string) => { const v = vars[k]; return v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v); });
export const PLACEHOLDERS = ['patientName', 'mrn', 'appointmentNo', 'doctorName', 'branchName', 'date', 'time', 'orderNo', 'testName', 'parameter', 'noShows', 'hospital'];
