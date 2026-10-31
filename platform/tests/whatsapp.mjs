#!/usr/bin/env node
// Phase 25: a patient books through WhatsApp. The test plays Meta: it posts signed webhook calls, reads the replies
// (WHATSAPP_PROVIDER=sim delivers them to Mailpit) and taps the reply buttons.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const HOST = 'citycare.localhost';
const SECRET = process.env.WHATSAPP_APP_SECRET ?? 'dev-whatsapp-app-secret';
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
const psql = (sql, db = 't_citycare') => execFileSync('docker', ['exec', 'medicare-postgres-1', 'psql', '-U', 'postgres', '-d', db, '-tAc', sql], { encoding: 'utf8' }).trim();
const SFX = Date.now().toString().slice(-6);
const LETTERS = SFX.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
const day = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86_400_000));

// ---- Meta's side ----
const PNID = '100000000001';
let seq = 0;
async function webhook(payload, sign = true) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', sign ? SECRET : 'wrong').update(raw).digest('hex')}`;
  return fetch(`${G}/api/assistant/v1/public/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
}
const msg = (from, m, pnid = PNID) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pnid, display_phone_number: '911234567890' }, messages: [{ from, id: `wamid.${SFX}.${seq++}`, timestamp: String(Math.floor(Date.now() / 1000)), ...m }] } }] }] });
const text = (from, body) => webhook(msg(from, { type: 'text', text: { body } }));
const tap = (from, id, title) => webhook(msg(from, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } }));
/** The WhatsApp messages sent to a number since `since` (full text, oldest first). */
async function inbox(digits, since) {
  const r = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${digits}@whatsapp.medicare.local`)}`)).json();
  const list = (r.messages ?? []).filter((m) => Date.parse(m.Created) >= since - 1000).sort((a, b) => Date.parse(a.Created) - Date.parse(b.Created));
  return Promise.all(list.map(async (m) => (await (await fetch(`http://localhost:61825/api/v1/message/${m.ID}`)).json()).Text));
}
const nextReply = async (digits, since, test, ms = 20000) => waitFor(async () => (await inbox(digits, since)).find(test), ms, 500);

// ---- the hospital: a WhatsApp number, the feature on, a doctor with morning hours ----
const city = (await fetch('http://localhost:4401/internal/tenants', { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }).then((r) => r.json())).find((t) => t.slug === 'citycare');
const linked = await fetch(`http://localhost:4415/internal/tenants/${city.id}/whatsapp`, { method: 'POST', headers: { 'x-internal-token': env.INTERNAL_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ phoneNumberId: PNID, displayNumber: '+91 12345 67890' }) });
check(linked.ok, 'City Care\'s WhatsApp Business number is linked');
const support = await staffToken('support@medicare.test', 'medicare');
const F = `/api/subscription/v1/platform/hospitals/${city.id}/features/ai.whatsapp`;
const admin = await staffToken('admin@citycare.test');
const A = (await call('GET', '/api/tenant/v1/branches', admin)).list.find((b) => b.name === 'Sector 44');
const name = `Dr. Wasim ${LETTERS[0].toUpperCase()}${LETTERS.slice(1)}`;
const doc = await call('POST', '/api/provider/v1/doctors', admin, { name, email: `wa.${SFX}@citycare.test`, registrationNo: `WA/${SFX}`, specialties: [{ code: 'DERMATOLOGY', primary: true }], branches: [{ branchId: A.id, fee: 400 }], consultModes: ['IN_PERSON'] });
await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'ACTIVE' });
await waitFor(async () => (await call('POST', `/api/scheduling/v1/doctors/${doc.id}/availability`, admin, { days: [1, 2, 3, 4, 5, 6, 7], branchId: A.id, startTime: '09:00', endTime: '12:00', slotMinutes: 30 })).http < 300, 30000, 1000);
await waitFor(async () => (await call('GET', `/api/search/v1/public/search/doctors?q=${encodeURIComponent(`wasim ${LETTERS}`)}`)).items?.some((d) => d.id === doc.id), 40000, 1000);

const digits = `9190${String(Date.now()).slice(-8)}`;
let t0 = Date.now();

// ======== 1. off until MediCare switches it on; only Meta's signed calls count ========
await text(digits, 'hi');
check(!!(await nextReply(digits, t0, (x) => /not available on WhatsApp/.test(x))), 'without "Assistant on WhatsApp" in the plan: a polite "not available"');
check((await webhook(msg(digits, { type: 'text', text: { body: 'hi' } }), false)).status === 401, 'a call not signed with the app secret is refused');
check((await call('PUT', F, support, { value: { enabled: true }, reason: 'whatsapp eval: on' }, 'medicare.localhost')).http === 200, 'MediCare switches "Assistant on WhatsApp" on for City Care');
await waitFor(async () => (await (await fetch(`http://localhost:4403/internal/tenants/${city.id}/features`, { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } })).json()).features?.['ai.whatsapp']?.enabled, 20000, 1000);
await sleep(31_000); // the assistant caches a hospital's features for 30 s

// ======== 2. linking the phone with the hospital's login code ========
t0 = Date.now();
await text(digits, 'hi');
check(!!(await nextReply(digits, t0, (x) => /sent a 6-digit login code by SMS/.test(x))), 'an unknown phone is asked for the login code sent by SMS');
const code = await waitFor(async () => {
  const m = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${digits}@sms.medicare.local`)}`)).json();
  return (m.messages ?? []).find((x) => Date.parse(x.Created) >= t0 - 1000)?.Snippet?.match(/^(\d{6}) is your/)?.[1];
});
check(!!code, 'the hospital\'s normal login code arrives by SMS');
t0 = Date.now();
await text(digits, code === '000000' ? '111111' : '000000');
check(!!(await nextReply(digits, t0, (x) => /code is not right/.test(x))), 'a wrong code is refused');
t0 = Date.now();
await text(digits, code);
check(!!(await nextReply(digits, t0, (x) => /You are linked/.test(x))), 'the right code links the phone (a normal patient session, kept encrypted)');
check(psql(`SELECT state || '|' || (refresh_enc IS NOT NULL) || '|' || (verified_until > now() + interval '29 days') FROM assistant.wa_links WHERE phone = '+${digits}'`) === 'LINKED|true|true', 'linked for 30 days; the session token is stored encrypted');
check(/^[0-9a-f-]{36}$/.test(psql(`SELECT person_id FROM assistant.wa_links WHERE phone = '+${digits}'`)), 'the phone is tied to the patient\'s account');
// a profile, as any new patient makes (booking needs one)
const tokenFor = async () => {
  const s = Date.now();
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone: `+${digits}` });
  const c = await waitFor(async () => { const m = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${digits}@sms.medicare.local`)}`)).json(); return (m.messages ?? []).find((x) => Date.parse(x.Created) >= s - 1000)?.Snippet?.match(/^(\d{6}) is your/)?.[1]; });
  return (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone: `+${digits}`, code: c })).accessToken;
};
const appToken = await tokenFor();
await call('PUT', '/api/patient/v1/me/profile', appToken, { fullName: `WhatsApp Patient ${SFX}`, dob: '1990-09-09' });

// ======== 3. booking: options, a card with buttons, Confirm ========
t0 = Date.now();
await text(digits, `Book an appointment with ${name} tomorrow morning`);
const card = await nextReply(digits, t0, (x) => /\(confirm:[0-9a-f-]{36}\)/.test(x), 30000);
const confirmId = card?.match(/\((confirm:[0-9a-f-]{36})\)/)?.[1];
check(!!card && card.includes(`Book ${name}`) && /09:00/.test(card) && /\(reject:/.test(card), `the booking card arrives with "Confirm booking" and "Not now" buttons:\n    ${card?.split('\n').slice(0, 3).join(' | ')}`);
check(!!(await nextReply(digits, t0, (x) => /Tap Confirm/.test(x))), 'with the options as text');
check((await call('GET', '/api/scheduling/v1/me/appointments', appToken)).upcoming?.length === 0, 'nothing booked before the tap');
t0 = Date.now();
await tap(digits, confirmId, 'Confirm booking');
const booked = await nextReply(digits, t0, (x) => /Booked\. Your appointment number is APT-/.test(x), 30000);
check(!!booked, `tapping Confirm books it: "${booked?.split('\n')[0]}"`);
const mine = (await call('GET', '/api/scheduling/v1/me/appointments', appToken)).upcoming ?? [];
check(mine.length === 1 && mine[0].doctor.id === doc.id && mine[0].localDate === day(1) && mine[0].localTime === '09:00', 'the appointment is the patient\'s, at the time on the card');
check(psql(`SELECT booked_via FROM scheduling.appointments WHERE appointment_no = '${mine[0]?.appointmentNo}'`) === 'ASSISTANT' && psql(`SELECT channel FROM assistant.conversations c JOIN assistant.wa_links l ON l.conversation_id = c.id WHERE l.phone = '+${digits}'`) === 'WHATSAPP', 'booked from the assistant, in a WhatsApp conversation');
t0 = Date.now();
await tap(digits, confirmId, 'Confirm booking');
check(!!(await nextReply(digits, t0, (x) => /Already done|Booked/.test(x))) && (await call('GET', '/api/scheduling/v1/me/appointments', appToken)).upcoming.length === 1, 'a second tap (Meta retries, double taps) books nothing more');

// ======== 4. what does not go to WhatsApp; duplicates; unknown numbers ========
t0 = Date.now();
await text(digits, 'What does my latest report mean?');
await nextReply(digits, t0, () => true, 20000);
const convo = psql(`SELECT conversation_id FROM assistant.wa_links WHERE phone = '+${digits}'`);
check(psql(`SELECT count(*) FROM assistant.tool_calls WHERE conversation_id = '${convo}' AND tool_name IN ('list_my_reports','explain_report')`) === '0', 'no report tools on WhatsApp: report contents stay in the app');
const dup = msg(digits, { type: 'text', text: { body: 'my appointments' } });
t0 = Date.now();
await webhook(dup); await webhook(dup);
await sleep(4000);
check((await inbox(digits, t0)).filter((x) => /upcoming appointments/i.test(x)).length === 1, 'the same message delivered twice is answered once');
const before = (await inbox(digits, 0)).length;
await webhook(msg(digits, { type: 'text', text: { body: 'hi' } }, '999999999999'));
await sleep(2000);
check((await inbox(digits, 0)).length === before, 'a number no hospital owns: ignored');

await call('PUT', F, support, { value: null, reason: 'whatsapp eval: back to the plan' }, 'medicare.localhost');
await call('POST', `/api/scheduling/v1/appointments/${mine[0]?.id}/cancel`, appToken, { reason: null });
await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'INACTIVE' });
console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mwhatsapp: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
