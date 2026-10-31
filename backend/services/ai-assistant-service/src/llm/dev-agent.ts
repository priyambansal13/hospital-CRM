import { parseUserTurn } from '../chat/prompts.js';
import type { ToolCall, ToolDecl, ToolResult, Turn } from './llm.js';

/**
 * The dev provider's tool use (Phase 23): a small, deterministic intent reader so local runs, CI and the booking-task
 * eval exercise the whole loop (tools → Confirm card → booking) without calling Google. It understands a handful of
 * phrasings ("need a skin doctor on Saturday morning", "the second one", "cancel my appointment", "how much is the
 * thyroid test"); Gemini does the real understanding. Returns null when it has nothing tool-related to do, and the
 * caller answers from the hospital information as before.
 */
export type DevStep = { calls: ToolCall[] } | { text: string } | null;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const BOOK = /\b(doctor|doctors|dr|appointment|book|consult|consultation|specialist|checkup|check-up|see someone)\b|डॉक्टर/;
const CANCEL = /\bcancel\b|रद्द/;
const MOVE = /\b(reschedule|postpone|move my|change (?:the )?time|shift my)\b/;
const REPORT = /\b(report|reports|result|results)\b|रिपोर्ट/;
const MINE = /\b(my appointments?|my bookings?|when is my|upcoming appointments?)\b/;
const LAB = /\b(test|tests|hba1c|thyroid|cbc|lipid|sugar|blood work|package|packages)\b/;
// preparation questions are answered from the hospital information (test preparation), not the catalog
const PREP = /\b(fast|fasting|prepare|preparation|before|eat|drink|water|empty stomach)\b|खाली पेट|उपवास/;
const ORDINALS: [RegExp, number][] = [[/\b(first|1st|option 1|number 1)\b/, 0], [/\b(second|2nd|option 2|number 2)\b/, 1], [/\b(third|3rd|option 3|number 3)\b/, 2]];
const FILLER = new Set('i need want a an the to for on in at with please some can you me my book booking appointment appointments doctor doctors dr consult consultation specialist see someone get find this next tomorrow today morning afternoon evening night am pm day after is there any available free time slot slots hello hi'.split(' ').concat(WEEKDAYS));

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function dateFrom(q: string, today: string): string | undefined {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(q)?.[1];
  if (iso) return iso;
  if (/\bday after tomorrow\b/.test(q)) return addDays(today, 2);
  if (/\btomorrow\b|\bkal\b/.test(q)) return addDays(today, 1);
  if (/\btoday\b|\baaj\b/.test(q)) return today;
  const w = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(q));
  if (w < 0) return undefined;
  const now = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, (w - now + 7) % 7);
}

export const partFrom = (q: string) => (/\bmorning\b|सुबह/.test(q) ? 'MORNING' : /\bafternoon\b|दोपहर/.test(q) ? 'AFTERNOON' : /\b(evening|night)\b|शाम/.test(q) ? 'EVENING' : undefined);

/** The words that say what kind of doctor ("skin", "heart", "Rao"), without the booking, date and time words. */
export function topic(q: string) {
  const words = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  // "skin doctor", "heart specialist": the search synonyms are phrased that way, so keep the pair
  return words.filter((w, i) => (!FILLER.has(w) && !/^\d+$/.test(w)) || (/^(doctor|specialist)$/.test(w) && i > 0 && !FILLER.has(words[i - 1]))).join(' ') || undefined;
}

type Slot = { slotId: string; date: string; time: string; branch: string; fee: number | null };
type SearchResult = { doctors: { doctorId: string; name: string; specialty: string | null; slots: Slot[] }[] };
type Appt = { appointmentId: string; appointmentNo: string; doctor: string | null; doctorId: string | null; date: string | null; time: string | null; patient: string | null };

/** The times offered after a doctor search, in the order they are shown: one per doctor first, then the rest. */
export function optionsFrom(r: SearchResult): (Slot & { doctor: string })[] {
  const out: (Slot & { doctor: string })[] = [];
  const max = Math.max(0, ...r.doctors.map((d) => d.slots.length));
  for (let i = 0; i < max && out.length < 3; i++) for (const d of r.doctors) if (d.slots[i] && out.length < 3) out.push({ ...d.slots[i], doctor: d.name });
  return out;
}

/** What a few common tests measure (the dev model's stand-in for the model's own knowledge). */
const MEASURES: [RegExp, string][] = [
  [/hba1c/i, 'HbA1c shows your average blood sugar over about the last 3 months.'],
  [/glucose|sugar/i, 'Blood glucose is the amount of sugar in your blood.'],
  [/haemoglobin|hemoglobin|^hb$/i, 'Haemoglobin carries oxygen in your blood.'],
  [/tsh/i, 'TSH is a hormone that controls the thyroid gland.'],
  [/cholesterol|ldl|hdl|triglyceride/i, 'This is one of the fats in your blood.'],
  [/creatinine|urea/i, 'This shows how well your kidneys clear waste.'],
  [/platelet/i, 'Platelets help your blood clot.'],
  [/wbc|white/i, 'White blood cells fight infection.'],
];
const measures = (name: string) => MEASURES.find(([re]) => re.test(name))?.[1] ?? '';

const fmt = (date: string, time: string) => `${new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))} ${time}`;

export function devAgentStep(turns: Turn[], tools: ToolDecl[]): DevStep {
  const has = (n: string) => tools.some((t) => t.name === n);
  // the patient's latest message, and what the tools returned since
  const at = turns.findLastIndex((t) => t.role === 'user' && !!t.text);
  if (at < 0) return null;
  const { question, today } = parseUserTurn(turns[at].text!);
  const q = question.toLowerCase();
  const day = today ?? new Date().toISOString().slice(0, 10);
  const now = turns.slice(at + 1).flatMap((t) => t.results ?? []);
  const last = (name: string, list: ToolResult[]) => list.findLast((r) => r.name === name)?.response as any;
  const earlier = turns.slice(0, at).flatMap((t) => t.results ?? []);
  const earlierAsk = turns.slice(0, at).filter((t) => t.role === 'user' && t.text).map((t) => parseUserTurn(t.text!).question.toLowerCase()).at(-1) ?? '';
  const call = (name: string, args: Record<string, unknown>): DevStep => ({ calls: [{ id: `dev-${name}-${now.length}`, name, args }] });
  const ordinal = ORDINALS.find(([re]) => re.test(q))?.[1];
  const time = /\b(\d{1,2}:\d{2})\b/.exec(q)?.[1]?.padStart(5, '0');

  // ---------- after a tool ran in this turn: the next step or the answer ----------
  if (now.length) {
    const r = now.at(-1)!;
    const res = r.response as any;
    if (res?.error && r.name.startsWith('propose_')) return { text: `${res.message ?? 'That did not work.'}` };
    switch (r.name) {
      case 'search_doctors': {
        const options = optionsFrom(res as SearchResult);
        if (!options.length) return { text: `I could not find a free time${res.date ? ` on ${fmt(res.date, '').trim()}` : ''}${res.partOfDay ? ` in the ${res.partOfDay.toLowerCase()}` : ''}. Try another day, or ask me for the next free time.` };
        if (has('propose_booking')) return call('propose_booking', { slotId: options[0].slotId });
        return { text: `Free times:\n${options.map((o, i) => `${i + 1}. ${o.doctor}, ${fmt(o.date, o.time)}, ${o.branch}`).join('\n')}\nBook on the doctor's page under "Find a doctor".` };
      }
      case 'propose_booking': {
        const s = last('search_doctors', now);
        const options = s ? optionsFrom(s) : [];
        const list = options.length > 1 ? `Free times:\n${options.map((o, i) => `${i + 1}. ${o.doctor}, ${fmt(o.date, o.time)}, ${o.branch}`).join('\n')}\n` : '';
        return { text: `${list}I have put ${res.doctor} on ${fmt(res.date, res.time)} for ${res.patient} on a card. Tap Confirm to book it${options.length > 1 ? ', or tell me another number' : ''}.` };
      }
      case 'list_my_appointments': {
        const list = (res.appointments ?? []) as Appt[];
        if (!list.length) return { text: 'You have no upcoming appointments.' };
        const lines = list.map((a, i) => `${i + 1}. ${a.appointmentNo}: ${a.doctor}, ${a.date && a.time ? fmt(a.date, a.time) : ''} (${a.patient})`).join('\n');
        if (CANCEL.test(q) && has('propose_cancel')) {
          const pick = list.length === 1 ? list[0] : ordinal != null ? list[ordinal] : list.find((a) => a.appointmentNo && q.includes(a.appointmentNo.toLowerCase()));
          return pick ? call('propose_cancel', { appointmentId: pick.appointmentId }) : { text: `Which one should I cancel?\n${lines}` };
        }
        if (MOVE.test(q) && has('propose_reschedule')) {
          const pick = list.length === 1 ? list[0] : ordinal != null ? list[ordinal] : undefined;
          if (!pick?.doctorId) return { text: `Which one should I move?\n${lines}` };
          return call('get_available_slots', { doctorId: pick.doctorId, date: dateFrom(q, day), partOfDay: partFrom(q) });
        }
        return { text: `Your upcoming appointments:\n${lines}` };
      }
      case 'get_available_slots': {
        const appts = (last('list_my_appointments', now)?.appointments ?? []) as Appt[];
        const pick = appts.length === 1 ? appts[0] : ordinal != null ? appts[ordinal] : undefined;
        const slot = (res.slots ?? [])[0] as Slot | undefined;
        if (!slot || !pick) return { text: 'That doctor has no free time then. Try another day.' };
        return call('propose_reschedule', { appointmentId: pick.appointmentId, newSlotId: slot.slotId });
      }
      case 'list_my_reports': {
        const list = (res.reports ?? []) as { orderId: string; orderNo: string; tests: string[]; date: string }[];
        if (!list.length) return { text: 'You have no ready lab reports yet. They appear under "My lab tests" once the doctor at the lab has checked them.' };
        const pick = ordinal != null ? list[ordinal] : list.find((r) => q.includes(r.orderNo.toLowerCase())) ?? list[0];
        return pick ? call('explain_report', { orderId: pick.orderId }) : { text: 'Which report do you mean?' };
      }
      case 'explain_report': {
        type V = { name: string; value: string; unit: string | null; normalRange: string | null; flag: string };
        const tests = (res.tests ?? []) as { test: string; values: V[] }[];
        const out = tests.flatMap((t) => t.values).filter((v) => v.flag !== 'NORMAL');
        const lines = out.map((v) => `- ${v.name} is ${v.value}${v.unit ? ` ${v.unit}` : ''}, ${v.flag === 'LOW' ? 'below' : v.flag === 'HIGH' ? 'above' : 'outside'} the normal range${v.normalRange ? ` (${v.normalRange})` : ''}. ${measures(v.name)}`.trim());
        const head = `Your ${tests.map((t) => t.test).join(', ')} report ${res.orderNo}${res.date ? ` from ${res.date}` : ''}:`;
        const body = out.length ? `${lines.join('\n')}\n${out.length < tests.flatMap((t) => t.values).length ? 'Everything else is in the normal range.' : ''}` : 'All the values are in the normal range.';
        return { text: `${head}\n${body}\nThese numbers alone are not a diagnosis. Please discuss these results with your doctor.${res.orderedBy ? ` I can book a follow-up with ${res.orderedBy} if you like.` : ''}` };
      }
      case 'propose_cancel': return { text: `Your cancellation of ${res.appointmentNo} is on a card. Tap the button to cancel it.` };
      case 'propose_reschedule': return { text: `The new time for ${res.appointmentNo} is on a card. Tap the button to move it.` };
      case 'search_lab_tests': {
        const items = [...(res.tests ?? []), ...(res.packages ?? [])].slice(0, 3);
        if (!items.length) return { text: 'I could not find that test. The "Lab tests" page lists them all.' };
        return { text: `${items.map((t: any) => `${t.name}: ₹${t.price}${t.fastingHours ? `, fast for ${t.fastingHours} hours before` : ', no fasting needed'}${t.reportInHours ? `, report in about ${t.reportInHours} hours` : ''}`).join('\n')}\nBook on the "Lab tests" page.` };
      }
      default: return null;
    }
  }

  // ---------- a new message: which tool first ----------
  // "the second one" / "10:30" right after the assistant offered times
  const offered = last('search_doctors', earlier);
  if (offered && (ordinal != null || time) && !CANCEL.test(q) && has('propose_booking')) {
    const options = optionsFrom(offered);
    const pick = time ? options.find((o) => o.time === time) : options[ordinal!];
    if (pick) return call('propose_booking', { slotId: pick.slotId });
  }
  // "the first one" after a list of appointments to cancel
  if (ordinal != null && CANCEL.test(earlierAsk) && last('list_my_appointments', earlier) && has('propose_cancel')) {
    const pick = (last('list_my_appointments', earlier).appointments as Appt[])[ordinal];
    if (pick) return call('propose_cancel', { appointmentId: pick.appointmentId });
  }
  if (REPORT.test(q) && has('list_my_reports')) return call('list_my_reports', {});
  if ((CANCEL.test(q) || MOVE.test(q) || MINE.test(q)) && has('list_my_appointments')) return call('list_my_appointments', {});
  if (LAB.test(q) && !BOOK.test(q) && !PREP.test(q) && has('search_lab_tests')) return call('search_lab_tests', { query: topic(q.replace(/\b(test|tests|price|cost|how|much|of|what|is|the)\b/g, ' ')) ?? q });
  if (BOOK.test(q) && has('search_doctors')) return call('search_doctors', { query: topic(q), date: dateFrom(q, day), partOfDay: partFrom(q) });
  return null;
}
