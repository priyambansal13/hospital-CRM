import type { Capabilities, TenantPlacement as Tenant } from '@mc/contracts';
import type { Actor } from '@mc/tenancy';
import type { ToolDecl } from '../llm/llm.js';

/**
 * The Care Concierge's tools (docs/AI-AGENTS.md §4.1, IMPLEMENTATION-PLAN.md Phase 23). Every tool calls the service
 * that owns the data WITH THE PATIENT'S OWN TOKEN, so that service's permission checks, branch rules and audit apply;
 * this service keeps no booking data. Nothing here books, cancels or reschedules: the propose_* tools only create a
 * pending action, and only the patient's Confirm button (POST v1/assistant/actions/:id/confirm) runs it.
 *
 * Tool results are kept small and contain only what the model needs to answer (ids, names, times, fees).
 */

export type PartOfDay = 'MORNING' | 'AFTERNOON' | 'EVENING';
export interface Slot { slotId: string; date: string; time: string; branch: string; fee: number | null; mode: string }
export interface FamilyMember { id: string; name: string; relation: string; isSelf: boolean }

/** What a propose_* tool asks ChatService to store as a Confirm card. */
export interface Proposal { type: 'BOOK_APPOINTMENT' | 'CANCEL_APPOINTMENT' | 'RESCHEDULE_APPOINTMENT'; payload: Record<string, unknown>; card: { title: string; lines: string[]; confirmLabel: string } }

export interface ToolContext {
  actor: Actor;
  tenant: Tenant;
  family: FamilyMember[];
  /** creates the pending action (Confirm card) and returns its id */
  propose: (p: Proposal) => Promise<string>;
}

export interface Tool { decl: ToolDecl; run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>> }

const URLS = {
  search: () => process.env.SVC_URL_SEARCH ?? 'http://localhost:4414',
  provider: () => process.env.SVC_URL_PROVIDER ?? 'http://localhost:4404',
  scheduling: () => process.env.SVC_URL_SCHEDULING ?? 'http://localhost:4405',
  diagnostics: () => process.env.SVC_URL_DIAGNOSTICS ?? 'http://localhost:4412',
  patient: () => process.env.SVC_URL_PATIENT ?? 'http://localhost:4406',
  records: () => process.env.SVC_URL_RECORDS ?? 'http://localhost:4410',
};

export class ToolError extends Error {}

/** A call to another service as the signed-in person (their token, their hospital): patients here, doctors in the copilot. */
export async function asPatient<T>(ctx: Pick<ToolContext, 'actor' | 'tenant'>, base: keyof typeof URLS, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`${URLS[base]()}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${ctx.actor.token}`, 'x-tenant-host': ctx.tenant.hosts[0], ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(6000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { code?: string; detail?: string };
  if (!res.ok) throw Object.assign(new ToolError(data.detail ?? `${base} ${res.status}`), { status: res.status, code: data.code });
  return data;
}

const tz = 'Asia/Kolkata';
export const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
const inPart = (time: string, part?: PartOfDay) => {
  if (!part) return true;
  const h = Number(time.slice(0, 2));
  return part === 'MORNING' ? h < 12 : part === 'AFTERNOON' ? h >= 12 && h < 17 : h >= 17;
};
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PARTS = ['MORNING', 'AFTERNOON', 'EVENING'];

/** Open slots of one doctor, optionally on one date and part of the day (the next 14 days). */
async function doctorSlots(ctx: ToolContext, doctorId: string, date?: string, part?: PartOfDay, max = 4): Promise<Slot[]> {
  const r = await asPatient<{ days: { date: string; slots: { slotId: string; localTime: string; mode: string; branch: { name: string }; fee: number | null }[] }[] }>(ctx, 'scheduling', `/v1/public/doctors/${doctorId}/slots?days=14`);
  const out: Slot[] = [];
  for (const d of r.days) {
    if (date && d.date !== date) continue;
    for (const s of d.slots) if (inPart(s.localTime, part) && s.mode === 'IN_PERSON') out.push({ slotId: s.slotId, date: d.date, time: s.localTime, branch: s.branch.name, fee: s.fee, mode: s.mode });
  }
  return out.slice(0, max);
}

type Doctor = { id: string; name: string; specialties: { code: string; name: string; primary: boolean }[]; languages: string[]; branches: { id: string; name: string; fee: number }[] };

async function findDoctors(ctx: ToolContext, q: string | undefined, specialty: string | undefined, branchId: string | undefined, language: string | undefined): Promise<Doctor[]> {
  const qs = new URLSearchParams({ limit: '5' });
  if (q) qs.set('q', q);
  if (specialty) qs.set('specialty', specialty);
  if (branchId) qs.set('branch', branchId);
  if (language) qs.set('language', language);
  // search-service knows symptom words ("skin" → dermatology); the directory is the fallback, as in the patient zone
  const r = await asPatient<{ items: Doctor[] }>(ctx, 'search', `/v1/public/search/doctors?${qs}`)
    .catch(() => asPatient<{ items: Doctor[] }>(ctx, 'provider', `/v1/public/doctors?${qs}`));
  return r.items.slice(0, 5);
}

const doctorSummary = (d: Doctor) => ({ doctorId: d.id, name: d.name, specialty: (d.specialties.find((s) => s.primary) ?? d.specialties[0])?.name ?? null, languages: d.languages });

const patientFor = (ctx: ToolContext, id: unknown) => {
  const p = (str(id) && ctx.family.find((m) => m.id === id)) || ctx.family.find((m) => m.isSelf) || ctx.family[0];
  if (!p) throw new ToolError('the patient has no profile yet: they must complete their profile first');
  return p;
};
const money = (n: number | null | undefined) => (n == null ? 'fee shown at the hospital' : `₹${n}`);
const when = (date: string, time: string) => `${new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))}, ${time}`;

type Appt = { id: string; appointmentNo: string; status: string; doctor?: { id: string; name: string }; doctorName?: string; branchName?: string; branch?: { name: string }; localDate?: string; localTime?: string; patient?: { id: string; name: string }; patientName?: string; fee?: number | null; paymentStatus?: string; rescheduleCount?: number };
const apptView = (a: Appt) => ({
  appointmentId: a.id, appointmentNo: a.appointmentNo, status: a.status, doctor: a.doctor?.name ?? a.doctorName ?? null, doctorId: a.doctor?.id ?? null,
  date: a.localDate ?? null, time: a.localTime ?? null, branch: a.branch?.name ?? a.branchName ?? null, patient: a.patient?.name ?? a.patientName ?? null,
});
async function upcoming(ctx: ToolContext) {
  const r = await asPatient<{ upcoming: Appt[]; policy: { cancelWindowHours: number; maxReschedules: number } }>(ctx, 'scheduling', '/v1/me/appointments');
  return { list: r.upcoming, policy: r.policy };
}

export const TOOLS: Record<string, Tool & { needs: (caps: Capabilities) => boolean }> = {
  triage_symptoms: {
    needs: (c) => c.modules.includes('directory'),
    decl: {
      name: 'triage_symptoms',
      description: 'Record how urgent the patient\'s problem sounds and which departments fit, before searching doctors. This is navigation, not diagnosis. Use EMERGENCY for anything that may need an emergency department now.',
      parameters: {
        type: 'object',
        properties: {
          urgency: { type: 'string', enum: ['EMERGENCY', 'URGENT_TODAY', 'SOON', 'ROUTINE'] },
          specialties: { type: 'array', items: { type: 'string' }, description: 'Specialty codes or names, e.g. DERMATOLOGY, Cardiology' },
        },
        required: ['urgency', 'specialties'],
      },
    },
    async run(args, ctx) {
      const urgency = ['EMERGENCY', 'URGENT_TODAY', 'SOON', 'ROUTINE'].includes(String(args.urgency)) ? String(args.urgency) : 'ROUTINE';
      const known = await asPatient<{ code: string; name: string }[]>(ctx, 'provider', '/v1/public/specialties');
      const wanted = (Array.isArray(args.specialties) ? args.specialties : []).map((s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
      // only departments this hospital has (the model may name one it does not)
      const specialties = known.filter((k) => wanted.some((w) => w === k.code || w === k.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'))).map((k) => ({ code: k.code, name: k.name }));
      return { urgency, specialties };
    },
  },

  search_doctors: {
    needs: (c) => c.modules.includes('directory'),
    decl: {
      name: 'search_doctors',
      description: 'Find this hospital\'s doctors by symptom words, specialty or name, with free in-person times. Give a date (YYYY-MM-DD) and part of the day when the patient said when. Returns at most 5 doctors with up to 3 times each.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symptom words, specialty or doctor name, e.g. "skin", "heart", "Dr Rao"' },
          specialty: { type: 'string', description: 'A specialty code from triage_symptoms, e.g. DERMATOLOGY' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          partOfDay: { type: 'string', enum: PARTS },
          language: { type: 'string', description: 'ISO code, e.g. hi' },
        },
      },
    },
    async run(args, ctx) {
      const date = str(args.date) && DATE.test(String(args.date)) ? String(args.date) : undefined;
      const part = PARTS.includes(String(args.partOfDay)) ? (String(args.partOfDay) as PartOfDay) : undefined;
      const specialty = str(args.specialty) && /^[A-Z][A-Z0-9_]{1,39}$/.test(String(args.specialty)) ? String(args.specialty) : undefined;
      let doctors = await findDoctors(ctx, str(args.query), specialty, undefined, str(args.language));
      // "skin" alone is not a search synonym, "skin doctor" is
      if (!doctors.length && str(args.query) && !/doctor|specialist/i.test(String(args.query)) && String(args.query).split(/\s+/).length <= 2) {
        doctors = await findDoctors(ctx, `${str(args.query)} doctor`, specialty, undefined, str(args.language));
      }
      const withSlots = await Promise.all(doctors.map(async (d) => ({ ...doctorSummary(d), slots: await doctorSlots(ctx, d.id, date, part, 3).catch(() => []) })));
      return { date: date ?? null, partOfDay: part ?? null, doctors: withSlots };
    },
  },

  get_available_slots: {
    needs: (c) => c.modules.includes('appointments'),
    decl: {
      name: 'get_available_slots',
      description: 'Free in-person times of one doctor in the next 14 days, optionally on one date and part of the day.',
      parameters: { type: 'object', properties: { doctorId: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, partOfDay: { type: 'string', enum: PARTS } }, required: ['doctorId'] },
    },
    async run(args, ctx) {
      const date = str(args.date) && DATE.test(String(args.date)) ? String(args.date) : undefined;
      const part = PARTS.includes(String(args.partOfDay)) ? (String(args.partOfDay) as PartOfDay) : undefined;
      return { doctorId: args.doctorId, slots: await doctorSlots(ctx, String(args.doctorId), date, part, 6) };
    },
  },

  list_my_appointments: {
    needs: (c) => c.modules.includes('appointments') && c.permissions.includes('appointment:read:own'),
    decl: { name: 'list_my_appointments', description: 'The patient\'s (and their family\'s) upcoming appointments.', parameters: { type: 'object', properties: {} } },
    async run(_args, ctx) {
      const { list, policy } = await upcoming(ctx);
      return { appointments: list.map(apptView), cancelWindowHours: policy.cancelWindowHours };
    },
  },

  search_lab_tests: {
    needs: (c) => c.modules.includes('diagnostics'),
    decl: {
      name: 'search_lab_tests',
      description: 'Find lab tests and packages by name or common words (e.g. "sugar test", "thyroid"): price, fasting, sample and report time.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    async run(args, ctx) {
      const q = encodeURIComponent(String(args.query ?? '').slice(0, 80));
      type Item = { code: string; name: string; price: number; fastingHours?: number | null; sampleType?: string | null; turnaroundHours?: number | null; preparation?: string | null };
      const r = await asPatient<{ tests: Item[]; packages: Item[] }>(ctx, 'search', `/v1/public/search/tests?q=${q}`)
        .catch(() => asPatient<{ tests: Item[]; packages: Item[] }>(ctx, 'diagnostics', `/v1/public/lab-catalog?q=${q}`));
      const view = (i: Item) => ({ code: i.code, name: i.name, price: i.price, fastingHours: i.fastingHours ?? null, sample: i.sampleType ?? null, reportInHours: i.turnaroundHours ?? null, preparation: i.preparation ?? null });
      return { tests: r.tests.slice(0, 4).map(view), packages: r.packages.slice(0, 2).map(view), howToBook: 'The patient books tests on the "Lab tests" page.' };
    },
  },

  list_my_reports: {
    needs: (c) => c.modules.includes('diagnostics') && c.permissions.includes('lab_order:read:own') && !!c.features['ai.reports']?.enabled,
    decl: { name: 'list_my_reports', description: 'The patient\'s (and their family\'s) lab reports that are ready (verified), newest first.', parameters: { type: 'object', properties: {} } },
    async run(_args, ctx) {
      const orders = await asPatient<{ id: string; orderNo: string; status: string; patient: { name: string }; tests: { name: string }[]; collectedAt: string | null; createdAt: string; orderedBy: { name: string } | null }[]>(ctx, 'diagnostics', '/v1/me/lab-orders');
      const ready = orders.filter((o) => o.status === 'REPORT_PUBLISHED').slice(0, 5);
      return { reports: ready.map((o) => ({ orderId: o.id, orderNo: o.orderNo, patient: o.patient.name, tests: o.tests.map((t) => t.name), date: localDate(new Date(o.collectedAt ?? o.createdAt)), orderedBy: o.orderedBy?.name ?? null })) };
    },
  },

  explain_report: {
    needs: (c) => c.modules.includes('diagnostics') && c.permissions.includes('lab_order:read:own') && !!c.features['ai.reports']?.enabled,
    decl: {
      name: 'explain_report',
      description: 'The structured values of one verified lab report (from list_my_reports): each value with its unit, normal range and flag, so you can explain in simple words what is outside the range and what the test measures. Never diagnose; end with "discuss with your doctor".',
      parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
    },
    async run(args, ctx) {
      type Param = { parameter: string; unit: string | null; refLow: number | null; refHigh: number | null; value: string | null; flag: string | null; critical: boolean };
      const sheet = await asPatient<{ order: { orderNo: string; patient: { name: string }; orderedBy: { name: string } | null }; collectedAt: string | null; tests: { name: string; parameters: Param[] }[] }>(ctx, 'diagnostics', `/v1/lab-orders/${encodeURIComponent(String(args.orderId))}/results`);
      // a critical value is never explained by the assistant: the lab calls the doctor first (docs/AI-AGENTS.md §4.4)
      if (sheet.tests.some((t) => t.parameters.some((p) => p.critical))) return { criticalHeld: true, orderNo: sheet.order.orderNo };
      const range = (p: Param) => (p.refLow != null && p.refHigh != null ? `${p.refLow}–${p.refHigh}` : p.refHigh != null ? `up to ${p.refHigh}` : p.refLow != null ? `from ${p.refLow}` : null);
      return {
        criticalHeld: false, orderNo: sheet.order.orderNo, patient: sheet.order.patient.name, date: sheet.collectedAt ? localDate(new Date(sheet.collectedAt)) : null, orderedBy: sheet.order.orderedBy?.name ?? null,
        tests: sheet.tests.map((t) => ({ test: t.name, values: t.parameters.filter((p) => p.value != null).map((p) => ({ name: p.parameter, value: p.value, unit: p.unit, normalRange: range(p), flag: p.flag ?? 'NORMAL' })) })),
      };
    },
  },

  propose_booking: {
    needs: (c) => c.modules.includes('appointments') && c.permissions.includes('appointment:create:own') && !!c.features['ai.booking']?.enabled,
    decl: {
      name: 'propose_booking',
      description: 'Show the patient a booking card to confirm. It does NOT book: the patient taps Confirm. Use after the patient chose a time (a slotId from search_doctors or get_available_slots).',
      parameters: { type: 'object', properties: { slotId: { type: 'string' }, patientId: { type: 'string', description: 'A family member id from <patient>; the patient themself if not said' }, reason: { type: 'string', description: 'A few words, e.g. "skin rash"' } }, required: ['slotId'] },
    },
    async run(args, ctx) {
      const slot = await asPatient<{ slotId: string; available: boolean; localDate: string; localTime: string; doctor: { id: string; name: string }; branch: { name: string }; fee: number | null }>(ctx, 'scheduling', `/v1/public/slots/${encodeURIComponent(String(args.slotId))}`);
      if (!slot.available) return { error: 'SLOT_UNAVAILABLE', message: 'That time is no longer free. Offer other times.' };
      const p = patientFor(ctx, args.patientId);
      const reason = str(args.reason)?.slice(0, 200) ?? null;
      const id = await ctx.propose({
        type: 'BOOK_APPOINTMENT', payload: { slotId: slot.slotId, patientId: p.id, reason },
        card: { title: `Book ${slot.doctor.name}`, lines: [when(slot.localDate, slot.localTime), slot.branch.name, `For ${p.name}`, `${money(slot.fee)}, pay at the hospital`], confirmLabel: 'Confirm booking' },
      });
      return { pendingActionId: id, shownToPatient: 'a booking card with a Confirm button', doctor: slot.doctor.name, date: slot.localDate, time: slot.localTime, patient: p.name };
    },
  },

  propose_cancel: {
    needs: (c) => c.modules.includes('appointments') && c.permissions.includes('appointment:read:own') && !!c.features['ai.booking']?.enabled,
    decl: {
      name: 'propose_cancel',
      description: 'Show the patient a card to cancel one of their upcoming appointments (from list_my_appointments). It does NOT cancel: the patient taps Confirm.',
      parameters: { type: 'object', properties: { appointmentId: { type: 'string' } }, required: ['appointmentId'] },
    },
    async run(args, ctx) {
      const { list, policy } = await upcoming(ctx);
      const a = list.find((x) => x.id === args.appointmentId);
      if (!a) return { error: 'NOT_FOUND', message: 'No such upcoming appointment. Use list_my_appointments.' };
      const v = apptView(a);
      const paid = a.paymentStatus === 'PAID';
      const id = await ctx.propose({
        type: 'CANCEL_APPOINTMENT', payload: { appointmentId: a.id },
        card: { title: `Cancel appointment ${a.appointmentNo}`, lines: [`${v.doctor}, ${v.date && v.time ? when(v.date, v.time) : ''}`, `For ${v.patient}`, paid ? `Paid online: refunded if cancelled at least ${policy.cancelWindowHours} hours before` : 'Nothing has been paid'], confirmLabel: 'Cancel appointment' },
      });
      return { pendingActionId: id, shownToPatient: 'a cancel card with a Confirm button', appointmentNo: a.appointmentNo };
    },
  },

  propose_reschedule: {
    needs: (c) => c.modules.includes('appointments') && c.permissions.includes('appointment:read:own') && !!c.features['ai.booking']?.enabled,
    decl: {
      name: 'propose_reschedule',
      description: 'Show the patient a card to move an upcoming appointment to a new time of the same doctor (newSlotId from get_available_slots). It does NOT move it: the patient taps Confirm.',
      parameters: { type: 'object', properties: { appointmentId: { type: 'string' }, newSlotId: { type: 'string' } }, required: ['appointmentId', 'newSlotId'] },
    },
    async run(args, ctx) {
      const { list, policy } = await upcoming(ctx);
      const a = list.find((x) => x.id === args.appointmentId);
      if (!a) return { error: 'NOT_FOUND', message: 'No such upcoming appointment. Use list_my_appointments.' };
      if ((a.rescheduleCount ?? 0) >= policy.maxReschedules) return { error: 'TOO_MANY_RESCHEDULES', message: `It was already moved ${policy.maxReschedules} times; it can only be cancelled.` };
      const slot = await asPatient<{ slotId: string; available: boolean; localDate: string; localTime: string; doctor: { id: string; name: string }; branch: { name: string } }>(ctx, 'scheduling', `/v1/public/slots/${encodeURIComponent(String(args.newSlotId))}`);
      if (!slot.available) return { error: 'SLOT_UNAVAILABLE', message: 'That time is no longer free. Offer other times.' };
      const v = apptView(a);
      if (v.doctorId && slot.doctor.id !== v.doctorId) return { error: 'OTHER_DOCTOR', message: 'A new time must be with the same doctor; to see another doctor, cancel and book again.' };
      const id = await ctx.propose({
        type: 'RESCHEDULE_APPOINTMENT', payload: { appointmentId: a.id, newSlotId: slot.slotId },
        card: { title: `Move appointment ${a.appointmentNo}`, lines: [`${slot.doctor.name}`, `From ${v.date && v.time ? when(v.date, v.time) : '—'}`, `To ${when(slot.localDate, slot.localTime)}, ${slot.branch.name}`, `For ${v.patient}`], confirmLabel: 'Move appointment' },
      });
      return { pendingActionId: id, shownToPatient: 'a reschedule card with a Confirm button', appointmentNo: a.appointmentNo };
    },
  },

  handoff_to_human: {
    needs: () => true,
    decl: { name: 'handoff_to_human', description: 'When you cannot help or the patient asks for a person: shows a "Talk to a person" button (the front desk calls back).', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
    async run() {
      return { shownToPatient: 'a "Talk to a person" button' };
    },
  },
};

/** The tools this patient may use here: the model never sees a tool the plan, the modules or the roles do not allow. */
export function toolsFor(caps: Capabilities): Tool[] {
  const readOnly = new Set(caps.readOnlyModules);
  return Object.values(TOOLS).filter((t) => {
    if (!t.needs(caps)) return false;
    // nothing new in a module that is read-only (a lapsed plan or a suspended subscription)
    if (t.decl.name.startsWith('propose_') && readOnly.has('appointments')) return false;
    return true;
  });
}

export const asUser = asPatient;
