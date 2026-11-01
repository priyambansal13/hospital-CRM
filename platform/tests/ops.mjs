#!/usr/bin/env node
// AI operations (Phase 29, part 2), against the local gateway with the dev model, on citycare:
//   Ops agent (answers from the semantic layer, figures checked, branch scoping, history, rating); the morning brief
//   (job → stored and e-mailed; rewrite on demand); care-gap reminders (Batch Mode drafts on module on → wording
//   rules → approval → a run reminds who is due, never twice in 90 days, never naming the condition); no-show
//   outreach (high-risk booking → "please confirm" → the patient's "I'm coming"). Modules reset afterwards.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': 'citycare.localhost', 'idempotency-key': crypto.randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
const internal = (port, path, body) => fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'x-internal-token': env.INTERNAL_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
async function staffToken(email) {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:citycare' }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
const waitFor = async (fn, ms = 20000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
async function patient(name) {
  const phone = `+9188${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const code = await waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6), 10000, 300);
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1975-02-02', gender: 'FEMALE' });
  return { token, phone, self };
}
const mc = (...a) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const psql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
const SFX = Date.now().toString().slice(-6);
const TID = psql('SELECT tenant_id FROM public.tenant_meta');
const ASK = '/api/assistant/v1/assistant/ops';

try {
  // ---- 1. modules on
  const admin = await staffToken('admin@citycare.test');
  const desk = await staffToken('desk@citycare.test');
  check((await call('POST', `${ASK}/ask`, admin, { question: 'appointments last week' })).http === 403, 'module off: the Ops agent is refused');
  // a clean start: earlier runs leave approved wording and reminders (kept across module off/on on purpose)
  psql('DELETE FROM assistant.care_gap_nudges; DELETE FROM assistant.care_gap_runs; DELETE FROM assistant.care_gap_messages; DELETE FROM assistant.ops_briefs');
  mc('module', 'enable', 'citycare', 'analytics');
  mc('module', 'enable', 'citycare', 'ai_ops');
  const ready = await waitFor(async () => (await call('GET', '/api/analytics/v1/analytics/status', admin)).loads?.every((l) => l.status === 'DONE') && (await call('GET', `${ASK}/questions`, admin)).http === 200, 120000, 2000);
  check(!!ready, 'modules on: warehouse loaded, Ops agent answering');

  // ---- 2. Ops agent
  check((await call('POST', `${ASK}/ask`, desk, { question: 'appointments last week' })).http === 403, 'the front desk cannot use the Ops agent');
  const a1 = await call('POST', `${ASK}/ask`, admin, { question: 'What was the no-show rate by day of the week in the last 30 days?' });
  const t1 = a1.tables?.[0];
  check(a1.http === 200 && t1?.groupLabel === 'Day of the week' && t1.rows.length === 7, `the question becomes a metric query (${t1?.title}, ${t1?.from} to ${t1?.to})`);
  const nums = (a1.answer?.match(/\d+(?:\.\d+)?(?=%)/g) ?? []).map(Number);
  check(a1.verified === true && a1.tables.length === 1 && nums.length > 0 && nums.every((n) => t1.rows.some((r) => r.value === n)), `the answer's figures come from the table: "${a1.answer?.slice(0, 120)}…"`);
  const a2 = await call('POST', `${ASK}/ask`, admin, { question: 'Which doctors were busiest by utilisation last week and which department had most appointments?' });
  check(a2.tables?.length === 2 && a2.tables.some((t) => t.groupLabel === 'Doctor') && a2.tables.some((t) => t.groupLabel?.startsWith('Department')), `two splits in one question: ${a2.tables?.map((t) => t.title).join(' + ')}`);
  const a3 = await call('POST', `${ASK}/ask`, admin, { question: 'What is the weather in Delhi?' });
  check(a3.http === 200 && !a3.tables?.length && /appointments, no-shows/.test(a3.answer), 'an off-topic question gets what it can help with, no figures');
  check(!JSON.stringify([a1, a2]).match(/"patient|mrn|phone/i), 'answers carry no patient details');
  check((await call('POST', `${ASK}/ask`, admin, { question: 'x' })).code === 'BAD_QUESTION', 'a too-short question is refused');
  check((await call('POST', `${ASK}/questions/${a1.id}/rating`, admin, { rating: 1 })).http === 204, 'admin rates an answer');
  const hist = await call('GET', `${ASK}/questions`, admin);
  check(hist.list?.[0]?.id === a3.id && hist.list.find((q) => q.id === a1.id)?.rating === 1, 'history keeps the questions, answers and rating');

  const branches = (await call('GET', '/api/diagnostics/v1/public/lab-branches')).list;
  const A = branches.find((b) => b.name === 'Sector 44') ?? branches[0];
  const B = branches.find((b) => b.id !== A.id);
  const email = `opsbr.${SFX}@example.test`;
  const inv = await call('POST', '/api/iam/v1/staff/invites', admin, { email, name: `Ops Branch ${SFX}`, roles: ['BRANCH_ADMIN'], branchId: B.id });
  await waitFor(async () => (await call('GET', `/api/entitlement/v1/users/${inv.userId}/roles`, admin)).list?.length > 0);
  const ba = await waitFor(() => staffToken(email).catch(() => null), 20000, 1000);
  const b1 = await call('POST', `${ASK}/ask`, ba, { question: 'Appointments by branch in the last 90 days' });
  check(b1.http === 200 && b1.tables?.[0]?.rows.every((r) => r.label === B.name), `a branch admin's answer covers only ${B.name} (${b1.tables?.[0]?.rows.map((r) => r.label).join(', ') || 'no rows'})`);

  // ---- 3. morning brief
  const made = await internal(4415, `/internal/tenants/${TID}/ops/briefs`, { hour: 0 });
  check(made.made >= 1, `brief job (any hour): ${made.made} branch brief(s) written`);
  const briefs = await call('GET', `${ASK}/briefs`, admin);
  const bA = briefs.list?.find((b) => b.branchId === A.id);
  check(!!bA && bA.points.length >= 2 && bA.verified === true, `${A.name}: "${bA?.headline}"`);
  check(!!(await waitFor(async () => (await mail(`to:admin@citycare.test subject:"Morning brief: ${A.name}"`)).length > 0, 30000, 1000)), 'the brief is e-mailed to the admin');
  check((await internal(4415, `/internal/tenants/${TID}/ops/briefs`, { hour: 0 })).made === 0, 'one brief per branch per day');
  check((await call('GET', `${ASK}/briefs`, ba)).list?.every((b) => b.branchId === B.id), 'a branch admin sees only their branch\'s brief');
  check((await call('POST', `${ASK}/briefs/${A.id}`, ba)).code === 'OUTSIDE_BRANCH', 'and cannot rewrite another branch\'s');
  const again = await call('POST', `${ASK}/briefs/${A.id}`, admin);
  check(again.http === 200 && again.id === bA?.id && again.emailed === true, 'admin rewrites today\'s brief (no second e-mail)');

  // ---- 4. care gaps
  const gaps = await waitFor(async () => { const g = await call('GET', `${ASK}/care-gaps`, admin); return g.list?.length === 3 && g.list.every((x) => x.status === 'DRAFT') ? g.list : null; }, 30000, 1000);
  check(!!gaps && gaps.every((g) => g.source === 'AI' && g.body.includes('{{link}}')), `module on: wording drafted through Batch Mode for ${gaps?.length} rules`);
  check(psql(`SELECT count(*) FROM assistant.batch_jobs WHERE status = 'DONE' AND kind = 'CARE_GAP_WORDING'`) !== '0', 'the batch job is recorded and collected');
  const dia = gaps.find((g) => g.rule === 'DIABETES_HBA1C');
  check((await call('POST', `${ASK}/care-gaps/DIABETES_HBA1C/run`, admin)).code === 'NOT_APPROVED', 'nothing is sent before a person approves the wording');
  check((await call('PUT', `${ASK}/care-gaps/DIABETES_HBA1C`, admin, { body: 'Hello {{patientName}}, time for your test at {{hospital}}.', status: 'APPROVED', version: dia.version })).code === 'BAD_WORDING', 'wording without the booking link is refused');
  check((await call('PUT', `${ASK}/care-gaps/DIABETES_HBA1C`, admin, { body: 'Hello {{patientName}}, as a diabetes patient please book your {{testName}}: {{link}}', status: 'APPROVED', version: dia.version })).code === 'BAD_WORDING', 'wording that names the condition is refused');
  check((await call('PUT', `${ASK}/care-gaps/DIABETES_HBA1C`, admin, { body: 'Hi {{name}}, book: {{link}} now please, thank you', status: 'APPROVED', version: dia.version })).code === 'BAD_WORDING', 'an unknown placeholder is refused');
  check((await call('GET', `${ASK}/care-gaps`, desk)).http === 403, 'the desk cannot see or approve care-gap wording');
  const ok = await call('PUT', `${ASK}/care-gaps/DIABETES_HBA1C`, admin, { status: 'APPROVED', version: dia.version });
  check(ok.status === 'APPROVED' && ok.source === 'AI', 'admin approves the drafted wording');
  const expectDue = Number(psql(`SELECT count(DISTINCT p.id) FROM records.diagnoses d JOIN records.encounters e ON e.id = d.encounter_id JOIN records.patients p ON p.id = e.patient_id
    WHERE e.status IN ('SIGNED','AMENDED') AND d.icd10_code ~ '^(E10|E11|E13|E14)' AND p.account_person_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM diagnostics.lab_orders o JOIN diagnostics.lab_order_items i ON i.order_id = o.id WHERE o.patient_id = p.id AND i.test_code = 'HBA1C'
        AND o.status NOT IN ('CANCELLED','EXPIRED','AWAITING_BOOKING') AND o.created_at > now() - interval '182 days')`));
  const run1 = await call('POST', `${ASK}/care-gaps/DIABETES_HBA1C/run`, admin);
  check(run1.http === 200 && run1.due === expectDue && run1.reminded + run1.skippedRecent === run1.due, `run: ${run1.due} diabetic patients due an HbA1c (records + diagnostics agree: ${expectDue}), ${run1.reminded} reminded`);
  const run2 = await call('POST', `${ASK}/care-gaps/DIABETES_HBA1C/run`, admin);
  check(run2.reminded === 0, 'running again reminds nobody (90 days between reminders)');
  const sent = psql(`SELECT account_person_id FROM assistant.care_gap_nudges WHERE rule = 'DIABETES_HBA1C' ORDER BY sent_at DESC LIMIT 1`);
  // reminders go by SMS (and e-mail where the account has one)
  const msg = await waitFor(async () => (await mail('"HbA1c blood test"')).find((m) => /book it here/.test(m.Snippet)), 30000, 1000);
  check(!!sent && !!msg && !/diabet/i.test(msg.Snippet), `the reminder arrives without naming the condition: "${msg?.Snippet.slice(0, 110)}…"`);

  // ---- 5. no-show outreach
  const P = await patient(`Ops Outreach ${SFX}`);
  const asha = await staffToken('asha.rao@citycare.test');
  const me = await call('GET', '/api/scheduling/v1/me/doctor', asha);
  for (let i = 0; i < 2; i++) {
    const w = await waitFor(async () => { const r = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: P.self.id, walkIn: { doctorId: me.id, branchId: A.id } }); return r.http === 201 ? r : null; }, 15000, 1000);
    await call('POST', `/api/scheduling/v1/appointments/${w.id}/no-show`, desk);
  }
  const doc = (await call('GET', '/api/provider/v1/public/doctors?q=asha')).items[0];
  const slot = (await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=10`)).days?.at(-1)?.slots?.at(-1);
  const appt = slot && await call('POST', '/api/scheduling/v1/appointments', P.token, { slotId: slot.slotId, patientId: P.self.id, paymentMode: 'AT_CLINIC' });
  // the visit is moved to tomorrow (Asha may have no free time tomorrow): the outreach looks at tomorrow's bookings
  psql(`UPDATE scheduling.appointments SET starts_at = now() + interval '1 day', ends_at = now() + interval '1 day 15 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date + 1 WHERE id = '${appt?.id}'`);
  check(appt?.http === 201, `a patient with 2 no-shows books a visit, tomorrow (${appt?.appointmentNo})`);
  const out = await internal(4405, `/internal/tenants/${TID}/noshow-outreach`, { hour: 0 });
  check(out.sent >= 1, `outreach job: ${out.sent} high-risk booking(s) asked to confirm`);
  const seen = await call('GET', `/api/scheduling/v1/appointments/${appt.id}`, P.token);
  check(!!seen.attendanceCheckSentAt && !seen.attendanceConfirmedAt && !('noShowRisk' in seen), 'the booking shows the request (the risk score stays with staff)');
  check((await call('GET', `/api/scheduling/v1/appointments/${appt.id}`, desk)).noShowRisk >= 3, 'the desk sees the risk score');
  const sms = await waitFor(async () => (await mail(`to:${P.phone.slice(1)}@sms.medicare.local`)).find((m) => /confirm you are coming/.test(m.Snippet)), 20000, 1000);
  check(!!sms, `SMS: "${sms?.Snippet.slice(0, 100)}…"`);
  check((await internal(4405, `/internal/tenants/${TID}/noshow-outreach`, { hour: 0 })).sent === 0, 'each booking is scored and asked once');
  const yes = await call('POST', `/api/scheduling/v1/appointments/${appt.id}/attendance`, P.token);
  check(yes.http === 200 && !!yes.attendanceConfirmedAt, 'the patient taps "I\'m coming"');
  const other = await patient(`Ops Other ${SFX}`);
  check((await call('POST', `/api/scheduling/v1/appointments/${appt.id}/attendance`, other.token)).http === 404, 'another patient cannot confirm it');
  await call('POST', `/api/scheduling/v1/appointments/${appt.id}/cancel`, P.token, {});
} catch (e) {
  console.error(e);
  failures++;
} finally {
  for (const m of ['ai_ops', 'analytics']) { try { mc('module', 'reset', 'citycare', m); } catch { /* reported above */ } }
}
console.log(failures ? `\x1b[31m${failures} check(s) failed\x1b[0m` : '\x1b[32mall ops checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
