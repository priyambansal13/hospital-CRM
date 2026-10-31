#!/usr/bin/env node
// Phase 23 booking-task eval: scripted conversations with the Care Concierge, through the gateway, as a patient.
// Locally the offline dev model drives the tools; with LLM_PROVIDER=gemini the same script checks the real model
// (MC_GATEWAY / MC_HOST point it at staging). The model only ever proposes: every booking, move and cancel here
// happens on the patient's Confirm.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = process.env.MC_GATEWAY ?? 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const HOST = process.env.MC_HOST ?? 'citycare.localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host = HOST) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': host, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
async function staffToken(email, slug = 'citycare') {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const waitFor = async (fn, ms = 20000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
async function patient(name) {
  const phone = `+9197${String(Date.now()).slice(-8)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const code = await waitFor(async () => {
    const m = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.slice(1)}@sms.medicare.local`)}`)).json();
    return m.messages?.[0]?.Snippet?.match(/\d{6}/)?.[0];
  });
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1988-03-03' });
  return token;
}
const psql = (sql, db = 't_citycare') => execFileSync('docker', ['exec', 'medicare-postgres-1', 'psql', '-U', 'postgres', '-d', db, '-tAc', sql], { encoding: 'utf8' }).trim();
const redis = (...args) => execFileSync('docker', ['exec', 'medicare-redis-1', 'redis-cli', '-a', env.REDIS_PASSWORD, '--no-auth-warning', ...args], { encoding: 'utf8' }).trim();
const ask = (token, text, conversationId) => call('POST', '/api/assistant/v1/assistant/messages', token, { text, ...(conversationId ? { conversationId } : {}) });
const SFX = Date.now().toString().slice(-6);
const LETTERS = SFX.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
const day = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86_400_000));

// ---- a dermatologist of our own with morning hours every day (so the times offered are known) ----
const admin = await staffToken('admin@citycare.test');
const A = (await call('GET', '/api/tenant/v1/branches', admin)).list.find((b) => b.name === 'Sector 44');
const name = `Dr. Kalpana ${LETTERS[0].toUpperCase()}${LETTERS.slice(1)}`;
const doc = await call('POST', '/api/provider/v1/doctors', admin, { name, email: `concierge.${SFX}@citycare.test`, registrationNo: `CC/${SFX}`, specialties: [{ code: 'DERMATOLOGY', primary: true }], branches: [{ branchId: A.id, fee: 450 }], consultModes: ['IN_PERSON'] });
await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'ACTIVE' });
await waitFor(async () => (await call('POST', `/api/scheduling/v1/doctors/${doc.id}/availability`, admin, { days: [1, 2, 3, 4, 5, 6, 7], branchId: A.id, startTime: '09:00', endTime: '12:00', slotMinutes: 30 })).http < 300, 30000, 1000);
const findable = await waitFor(async () => (await call('GET', `/api/search/v1/public/search/doctors?q=${encodeURIComponent(`kalpana ${LETTERS}`)}`)).items?.some((d) => d.id === doc.id), 40000, 1000);
check(!!findable && !!(await waitFor(async () => (await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=3`)).days?.some((d) => d.date === day(1)), 30000, 1000)), `${name} (Dermatology) is searchable with morning times tomorrow`);
const ask1 = `Book an appointment with ${name} tomorrow morning`;

// ---- 1. a booking request: options and a Confirm card, nothing booked yet ----
const P = await patient('Concierge Patient');
const usageKey = `usage:${psql('SELECT tenant_id FROM public.tenant_meta')}:ai.concierge:${new Date().toISOString().slice(0, 7)}`;
const used = () => Number(redis('GET', usageKey) || 0);
const u0 = used();
const r1 = await ask(P, ask1);
const card1 = r1.message?.cards?.[0];
check(r1.message?.kind === 'ANSWER' && card1?.type === 'BOOK_APPOINTMENT' && card1.status === 'PENDING', `"${ask1}" → a booking card (${r1.message?.kind}, ${card1?.type})`);
check(card1?.title?.includes(name) && card1.lines.some((l) => /09:00/.test(l)) && card1.lines.some((l) => /450/.test(l)), `the card shows the doctor, the first morning time and the fee: ${card1?.lines?.join(' | ')}`);
check(/Tap Confirm/.test(r1.message?.text ?? ''), 'the answer says to tap Confirm, it does not claim a booking');
check((await call('GET', '/api/scheduling/v1/me/appointments', P)).upcoming?.length === 0, 'nothing is booked before Confirm');
check(used() - u0 === 1, 'one message counts once against the allowance, however many tool steps it took');

// ---- 2. "the second one" in the same chat ----
const r2 = await ask(P, 'the second one please', r1.conversationId);
const card2 = r2.message?.cards?.[0];
check(card2?.type === 'BOOK_APPOINTMENT' && card2.id !== card1?.id && card2.lines.some((l) => /09:30/.test(l)), `"the second one" → a card for the second time offered: ${card2?.lines?.[0]}`);

// ---- 3. Confirm books through the normal booking API, once ----
const c2 = await call('POST', `/api/assistant/v1/assistant/actions/${card2?.id}/confirm`, P);
check(c2.http === 200 && c2.action?.status === 'CONFIRMED' && /^APT-/.test(c2.action?.result?.appointmentNo ?? '') && c2.message?.kind === 'ACTION', `Confirm → booked ${c2.action?.result?.appointmentNo}: "${c2.message?.text}"`);
const mine = (await call('GET', '/api/scheduling/v1/me/appointments', P)).upcoming ?? [];
check(mine.length === 1 && mine[0].appointmentNo === c2.action?.result?.appointmentNo && mine[0].doctor.id === doc.id && mine[0].localTime === '09:30', 'the appointment is in "My appointments" (doctor and time as on the card)');
check(psql(`SELECT booked_via FROM scheduling.appointments WHERE appointment_no = '${c2.action?.result?.appointmentNo}'`) === 'ASSISTANT', 'scheduling records it was booked from the assistant');
const again = await call('POST', `/api/assistant/v1/assistant/actions/${card2?.id}/confirm`, P);
check(again.http === 200 && again.action?.result?.appointmentNo === c2.action?.result?.appointmentNo && (await call('GET', '/api/scheduling/v1/me/appointments', P)).upcoming.length === 1, 'a second Confirm books nothing more');

// ---- 4. Not now; other people's cards; expiry ----
const rj = await call('POST', `/api/assistant/v1/assistant/actions/${card1?.id}/reject`, P);
check(rj.action?.status === 'REJECTED' && (await call('POST', `/api/assistant/v1/assistant/actions/${card1?.id}/confirm`, P)).http === 409, '"Not now" closes the card; it cannot be confirmed afterwards');
const Q = await patient('Concierge Other');
const r3 = await ask(P, `Book ${name} on ${day(3)} morning`);
const card3 = r3.message?.cards?.[0];
check(!!card3 && (await call('POST', `/api/assistant/v1/assistant/actions/${card3.id}/confirm`, Q)).http === 404, 'another patient cannot confirm (or see) the card: 404');
psql(`UPDATE assistant.pending_actions SET expires_at = now() - interval '1 minute' WHERE id = '${card3?.id}'`);
const ex = await call('POST', `/api/assistant/v1/assistant/actions/${card3?.id}/confirm`, P);
check(ex.http === 409 && ex.code === 'ACTION_EXPIRED', `a card older than 15 minutes cannot be confirmed (${ex.code})`);
const hist = (await call('GET', `/api/assistant/v1/assistant/conversations/${r1.conversationId}/messages`, P)).list ?? [];
check(hist.find((m) => m.id === r1.message?.id)?.cards?.[0]?.status === 'REJECTED' && hist.find((m) => m.id === r2.message?.id)?.cards?.[0]?.status === 'CONFIRMED', 'the chat history shows each card with its outcome');

// ---- 5. move it, then cancel it, each on its own card ----
const r4 = await ask(P, `please reschedule my appointment to ${day(2)} morning`);
const card4 = r4.message?.cards?.[0];
check(card4?.type === 'RESCHEDULE_APPOINTMENT' && card4.lines.some((l) => /^To /.test(l)), `"reschedule my appointment to ${day(2)} morning" → a move card: ${card4?.lines?.join(' | ')}`);
const c4 = await call('POST', `/api/assistant/v1/assistant/actions/${card4?.id}/confirm`, P);
const moved = (await call('GET', '/api/scheduling/v1/me/appointments', P)).upcoming ?? [];
check(c4.action?.status === 'CONFIRMED' && moved.length === 1 && moved[0].localDate === day(2), `Confirm → moved to ${moved[0]?.localDate} ${moved[0]?.localTime} (${c4.action?.result?.appointmentNo})`);
const r5 = await ask(P, 'cancel my appointment');
const card5 = r5.message?.cards?.[0];
check(card5?.type === 'CANCEL_APPOINTMENT' && card5.lines.some((l) => /Nothing has been paid/.test(l)), `"cancel my appointment" → a cancel card: ${card5?.lines?.join(' | ')}`);
const c5 = await call('POST', `/api/assistant/v1/assistant/actions/${card5?.id}/confirm`, P);
check(c5.action?.status === 'CONFIRMED' && (await call('GET', '/api/scheduling/v1/me/appointments', P)).upcoming.length === 0, 'Confirm → cancelled; nothing upcoming');

// ---- 6. a taken time: the card fails cleanly ----
const r6 = await ask(P, ask1);
const card6 = r6.message?.cards?.[0];
const slot6 = psql(`SELECT payload->>'slotId' FROM assistant.pending_actions WHERE id = '${card6?.id}'`);
const QP = (await call('GET', '/api/patient/v1/me/patients', Q)).list?.[0];
await call('POST', '/api/scheduling/v1/appointments', Q, { slotId: slot6, patientId: QP?.id, reason: null, paymentMode: 'AT_CLINIC' });
const c6 = await call('POST', `/api/assistant/v1/assistant/actions/${card6?.id}/confirm`, P);
check(c6.action?.status === 'FAILED' && c6.action?.result?.error === 'SLOT_UNAVAILABLE' && /just taken/.test(c6.message?.text ?? '') && c6.message?.offerHandoff, 'a time someone else just took: the card fails with a clear message and a person on offer');

// ---- the plan's demo phrase: symptom words find the department (search synonyms), not a doctor's name ----
const weekday = new Intl.DateTimeFormat('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + 86_400_000));
const rs = await ask(P, `need a skin doctor ${weekday} morning`);
const cs = rs.message?.cards?.[0];
const csDoctor = cs ? psql(`SELECT payload->>'slotId' FROM assistant.pending_actions WHERE id = '${cs.id}'`) : '';
const derm = csDoctor ? psql(`SELECT count(*) FROM provider.doctor_specialties ds JOIN provider.specialties sp ON sp.id = ds.specialty_id WHERE sp.code = 'DERMATOLOGY' AND ds.doctor_id = (SELECT doctor_id FROM scheduling.slots WHERE id = '${csDoctor}')`) : '0';
check(cs?.type === 'BOOK_APPOINTMENT' && derm === '1' && cs.lines.some((l) => /0\d:\d\d|1[01]:\d\d/.test(l)), `"need a skin doctor ${weekday} morning" → a dermatologist's morning time on a card: ${cs?.title}, ${cs?.lines?.[0]}`);
if (cs) await call('POST', `/api/assistant/v1/assistant/actions/${cs.id}/reject`, P);

// ---- 7. lab tests and hospital questions ----
const r7 = await ask(P, 'How much is the thyroid test?');
check(r7.message?.kind === 'ANSWER' && /₹\d+/.test(r7.message?.text ?? '') && !r7.message?.cards?.length, `lab test question → prices from the catalog: ${r7.message?.text?.split('\n')[0]}`);
const r8 = await ask(P, 'What are the visiting hours?');
check(r8.message?.kind === 'ANSWER' && r8.message?.sources?.length > 0, 'hospital questions are still answered from the hospital information, with the source');

// ---- 8. the plan decides: without booking from the assistant, no tool can propose ----
const support = await staffToken('support@medicare.test', 'medicare');
const city = (await fetch('http://localhost:4401/internal/tenants', { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }).then((r) => r.json())).find((t) => t.slug === 'citycare');
const off = await call('PUT', `/api/subscription/v1/platform/hospitals/${city.id}/features/ai.booking`, support, { value: { enabled: false }, reason: 'concierge eval: booking off' }, 'medicare.localhost');
check(off.http === 200, `MediCare support switches "Booking from the AI assistant" off for City Care (${off.http})`);
const r9 = await waitFor(async () => { const r = await ask(P, ask1); return !r.message?.cards?.length && r; }, 30000, 2000);
check(!!r9 && /Find a doctor/.test(r9.message?.text ?? ''), `without the feature: times are listed, no card, "Find a doctor" offered: ${r9?.message?.text?.split('\n').at(-1)}`);
const on = await call('PUT', `/api/subscription/v1/platform/hospitals/${city.id}/features/ai.booking`, support, { value: null, reason: 'concierge eval: back to the plan' }, 'medicare.localhost');
check(on.http < 300, 'the override is removed again');

// ---- 9. what is kept ----
const logged = psql(`SELECT count(*) || '|' || count(*) FILTER (WHERE input ? 'reason') FROM assistant.tool_calls WHERE conversation_id = '${r1.conversationId}'`).split('|');
check(Number(logged[0]) >= 3 && logged[1] === '0', `every tool call is logged (${logged[0]} for the first chat), without the free-text reason`);
check(psql(`SELECT count(*) FROM assistant.messages WHERE id = '${r1.message?.id}' AND trace_enc IS NOT NULL AND position('${name}' in encode(trace_enc, 'escape')) = 0`) === '1', 'the tool trace is stored encrypted (no doctor names in clear)');

await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'INACTIVE' });
console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mconcierge: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
