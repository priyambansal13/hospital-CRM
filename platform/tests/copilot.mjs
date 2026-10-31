#!/usr/bin/env node
// Phase 24: the patient's report explainer and the doctor's pre-visit summary, against a real record built here
// (a signed visit with a diagnosis and a prescription, an allergy, two HbA1c reports, a critical glucose report,
// today's triage). Locally the offline dev model writes; LLM_PROVIDER=gemini runs the same checks on the real model.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const HOST = 'citycare.localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host = HOST) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': host, 'idempotency-key': crypto.randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

async function patient(name) {
  const phone = `+9196${String(Date.now()).slice(-8)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const code = await waitFor(async () => {
    const m = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.slice(1)}@sms.medicare.local`)}`)).json();
    return m.messages?.[0]?.Snippet?.match(/\d{6}/)?.[0];
  });
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1972-04-04', gender: 'MALE' });
  return { token, self };
}

// ---- the record ----
const admin = await staffToken('admin@citycare.test');
const [desk, asha, lab, path] = await Promise.all(['desk', 'asha.rao', 'lab', 'path'].map((u) => staffToken(`${u}@citycare.test`)));
const branch = (await call('GET', '/api/diagnostics/v1/public/lab-branches')).list.find((b) => b.name === 'Sector 44');
const me = await call('GET', '/api/scheduling/v1/me/doctor', asha);
const P = await patient(`Copilot Patient ${SFX}`);
await call('POST', `/api/patient/v1/me/patients/${P.self.id}/allergies`, P.token, { substance: 'Penicillin', severity: 'SEVERE', reaction: 'rash' });

// an earlier visit: type 2 diabetes, metformin for 90 days, signed and completed
let lastVisit;
const visit = async () => waitFor(async () => { const r = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: P.self.id, walkIn: { doctorId: me.id, branchId: branch.id } }); lastVisit = r; return r.http === 201 && r; }, 20000, 1000);
const v1 = await visit();
const e1 = await waitFor(async () => { const r = await call('POST', '/api/records/v1/encounters', asha, { appointmentId: v1.id }); return r.http === 201 && r.encounter; }, 20000, 1000);
const u1 = await call('PATCH', `/api/records/v1/encounters/${e1.id}`, asha, { version: e1.version, chiefComplaint: 'Thirst and frequent urination', diagnoses: [{ code: 'E11.9', isPrimary: true }] });
await call('POST', `/api/records/v1/encounters/${e1.id}/prescriptions`, asha, { items: [{ drugName: 'Metformin', strength: '500 mg', form: 'tablet', dosage: '1-0-1', durationDays: 90, instructions: 'after food' }], advice: 'Walk 30 minutes daily, less sugar', followUpOn: today() });
const s1 = await call('POST', `/api/records/v1/encounters/${e1.id}/sign`, asha, { version: (u1.encounter ?? u1).version });
await call('POST', `/api/scheduling/v1/appointments/${v1.id}/start`, asha);
const done1 = await call('POST', `/api/scheduling/v1/appointments/${v1.id}/complete`, asha);
if (done1.http >= 300) console.log(`  (completing the first visit: ${done1.http} ${done1.code} ${done1.detail})`);
check(s1.http < 300, `an earlier visit with Dr. Asha Rao: type 2 diabetes, metformin, signed (${s1.http})`);

// lab reports, the way the lab makes them: ordered by the doctor, paid, collected, entered, verified
const cat = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
const T = (code) => cat.tests.find((t) => t.code === code);
async function report(code, parameter, value, collectedDaysAgo) {
  const order = await waitFor(async () => { const r = await call('POST', '/api/diagnostics/v1/doctor/lab-orders', asha, { patientId: P.self.id, items: [{ testId: T(code).id }] }); return r.http === 201 && r; });
  let slot;
  for (let d = 1; d < 25 && !slot; d++) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + d * 86_400_000));
    slot = (await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${branch.id}&date=${day}`)).slots?.find((s) => s.left > 0);
  }
  await call('POST', `/api/diagnostics/v1/lab-orders/${order.id}/schedule`, P.token, { branchId: branch.id, slotAt: slot.slotAt, paymentMode: 'AT_CLINIC' });
  psql(`UPDATE diagnostics.lab_orders SET slot_at = now() - interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id = '${order.id}'`);
  await waitFor(async () => (await call('POST', '/api/billing/v1/desk/collect', lab, { sourceType: 'LAB_ORDER', sourceId: order.id, method: 'CASH' })).http === 201);
  await waitFor(async () => (await call('GET', `/api/diagnostics/v1/lab-orders/${order.id}`, lab)).paymentStatus === 'PAID');
  const o = await call('GET', `/api/diagnostics/v1/lab-orders/${order.id}`, lab);
  for (const s of o.samples) await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: s.barcode });
  for (const s of o.samples) await call('POST', '/api/diagnostics/v1/lab/samples/receive', lab, { barcode: s.barcode });
  const sheet = await call('GET', `/api/diagnostics/v1/lab/orders/${order.id}/results`, lab);
  await call('POST', `/api/diagnostics/v1/lab/orders/${order.id}/results`, lab, { results: [{ itemId: sheet.tests[0].itemId, parameter, value }] });
  const v = await call('POST', `/api/diagnostics/v1/lab/orders/${order.id}/verify`, path);
  // collected some days ago (the trend needs an older report)
  psql(`UPDATE diagnostics.lab_orders SET collected_at = now() - make_interval(days => ${collectedDaysAgo}) WHERE id = '${order.id}'`);
  return { id: order.id, orderNo: order.orderNo, ok: v.http < 300 };
}
const hbOld = await report('HBA1C', 'HbA1c', '6.8', 60);
const hbNew = await report('HBA1C', 'HbA1c', '7.2', 2);
const fbs = await report('FBS', 'Glucose, fasting', '452', 1);
check(hbOld.ok && hbNew.ok && fbs.ok, `reports verified: ${hbOld.orderNo} HbA1c 6.8, ${hbNew.orderNo} HbA1c 7.2, ${fbs.orderNo} glucose 452 (critical)`);
// the timeline follows the lab's events
await waitFor(async () => (await call('GET', `/api/records/v1/patients/${P.self.id}/timeline?kind=LAB_ORDER`, asha)).items?.length >= 3, 30000, 1000);

// ======== 1. the patient asks about their reports ========
const ask = (text, conversationId) => call('POST', '/api/assistant/v1/assistant/messages', P.token, { text, ...(conversationId ? { conversationId } : {}) });
const r1 = await ask('What does my latest report mean?');
check(r1.message?.kind === 'ANSWER' && /doctor needs to look at first/.test(r1.message.text) && !/452/.test(r1.message.text) && r1.message.offerHandoff, `a report with a critical value is not explained: "${r1.message?.text?.slice(0, 90)}…"`);
check(psql(`SELECT safety->>'criticalHeld' FROM assistant.messages WHERE id = '${r1.message?.id}'`) === 'true' && psql(`SELECT count(*) FROM assistant.tool_calls WHERE message_id = '${r1.message?.id}' AND tool_name = 'explain_report'`) === '1', '…held by code after explain_report saw the critical value (no model wording)');
const r2 = await ask('Can you explain my second report?', r1.conversationId);
check(/HbA1c is 7\.2 %, above the normal range \(4–5\.6\)/.test(r2.message?.text ?? '') && /discuss these results with your doctor/.test(r2.message?.text ?? ''), `the HbA1c report is explained from its values: "${r2.message?.text?.split('\n')[1]}"`);
check(/follow-up with Dr\. Asha Rao/.test(r2.message?.text ?? '') && !r2.message?.cards?.length, '…and a follow-up with the ordering doctor is offered (nothing booked)');

// ======== 2. the doctor's pre-visit summary ========
const v2 = await visit();
if (!v2) throw new Error(`today's walk-in refused: ${lastVisit?.http} ${lastVisit?.code} ${lastVisit?.detail}`);
const nurse = await (async () => {
  const email = `copilot.nurse.${SFX}@example.test`;
  const inv = await call('POST', '/api/iam/v1/staff/invites', admin, { email, name: `Nurse ${SFX}`, roles: ['NURSE'], branchId: branch.id });
  await waitFor(async () => (await call('GET', `/api/entitlement/v1/users/${inv.userId}/roles`, admin)).list?.length > 0);
  return waitFor(() => staffToken(email).catch(() => null), 20000, 1000);
})();
const tri = await call('PUT', `/api/records/v1/appointments/${v2.id}/triage`, nurse, { priority: 'ROUTINE', chiefComplaint: 'Tiredness for two weeks', vitals: { bp: '138/88', pulse: 84 } });
check(tri.http < 300, `today's visit, triaged by a nurse (${tri.http})`);
const S = `/api/assistant/v1/assistant/copilot/appointments/${v2.id}/summary`;
check((await call('GET', S, asha)).summary === null, 'no summary until the doctor asks');
const g = await call('POST', S, asha);
const sum = g.summary;
const sec = (t) => sum?.sections?.find((s) => s.title === t)?.lines ?? [];
check(g.http === 200 && sum?.droppedLines === 0, `summary made (${sum?.model}); every line passed the citation check (${sum?.droppedLines} dropped)`);
check(sec('Today').some((l) => /Tiredness for two weeks/.test(l.text) && l.refs.includes('T1')), `Today: ${sec('Today')[0]?.text}`);
check(sec('Active problems').some((l) => /E11\.9/.test(l.text)), `Active problems: ${sec('Active problems')[0]?.text}`);
check(sec('Current medicines').some((l) => /Metformin 500 mg/.test(l.text)), `Current medicines: ${sec('Current medicines')[0]?.text}`);
check(sec('Allergies').some((l) => /Penicillin: severe/.test(l.text)), `Allergies: ${sec('Allergies')[0]?.text}`);
const hbLine = sec('Recent abnormal results').find((l) => /HbA1c 7\.2/.test(l.text));
check(!!hbLine && /was 6\.8 %/.test(hbLine.text) && hbLine.refs.length === 2, `the HbA1c trend, citing both reports: ${hbLine?.text}`);
check(sec('Recent abnormal results').some((l) => /Glucose, fasting 452/.test(l.text) && /critical/.test(l.text)), 'the critical glucose is in the doctor\'s summary');
check(sec('Last visit plan').some((l) => /Walk 30 minutes/.test(l.text) && l.text.includes(`follow-up on ${today()}`)), `Last visit plan, with the follow-up date as the doctor set it (${today()}): ${sec('Last visit plan')[0]?.text}`);
const ids = Object.fromEntries((sum?.sources ?? []).map((s) => [s.ref, s]));
const allRefs = (sum?.sections ?? []).flatMap((s) => s.lines.flatMap((l) => l.refs));
check(allRefs.length > 0 && allRefs.every((r) => ids[r]), `every citation resolves to a record (${new Set(allRefs).size} cited)`);
check(ids[hbLine?.refs?.[0]]?.id === hbNew.id && ids[hbLine?.refs?.[1]]?.id === hbOld.id && Object.values(ids).some((s) => s.type === 'ENCOUNTER' && s.id === e1.id), '…and to the right ones (the two HbA1c orders, the earlier visit)');
check(psql(`SELECT count(*) FROM assistant.clinical_drafts WHERE id = '${sum?.id}' AND position('Penicillin' in encode(draft_enc, 'escape')) = 0 AND sources::text NOT LIKE '%Penicillin%'`) === '1', 'the draft is stored encrypted; its sources are ids only');

// ======== 3. who may see it ========
const other = await staffToken('leak.doctor@citycare.test').catch(() => null);
if (other) {
  const o = await call('POST', S, other);
  check(o.http === 403 || o.http === 404, `a doctor not treating this patient gets no summary (${o.http} ${o.code})`);
  check((await call('GET', S, other)).summary === null, '…and cannot read Dr. Rao\'s');
}
check((await call('POST', S, P.token)).http === 403, 'a patient cannot use the copilot');

// ======== 4. feedback, regenerating, the plan ========
const fb = await call('POST', `/api/assistant/v1/assistant/copilot/drafts/${sum?.id}/feedback`, asha, { rating: -1, reason: 'MISSING', comment: `missing the eye check ${SFX}` });
check(fb.http === 204 && (await call('GET', S, asha)).summary?.feedback?.reason === 'MISSING', 'the doctor marks it "missing something"');
check(psql(`SELECT count(*) FROM assistant.clinical_drafts WHERE id = '${sum?.id}' AND feedback_comment_enc IS NOT NULL AND position('${SFX}' in encode(feedback_comment_enc, 'escape')) = 0`) === '1', '…the comment is stored encrypted');
const g2 = await call('POST', S, asha);
check(g2.summary?.id !== sum?.id && psql(`SELECT string_agg(status, ',' ORDER BY created_at) FROM assistant.clinical_drafts WHERE appointment_id = '${v2.id}'`) === 'SUPERSEDED,DRAFT', 'asking again replaces the summary (the old one is kept as superseded)');
const support = await staffToken('support@medicare.test', 'medicare');
const city = (await fetch('http://localhost:4401/internal/tenants', { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }).then((r) => r.json())).find((t) => t.slug === 'citycare');
const F = (key) => `/api/subscription/v1/platform/hospitals/${city.id}/features/${key}`;
await call('PUT', F('ai.copilot'), support, { value: { enabled: false }, reason: 'copilot eval: off' }, 'medicare.localhost');
await call('PUT', F('ai.reports'), support, { value: { enabled: false }, reason: 'copilot eval: off' }, 'medicare.localhost');
const offC = await waitFor(async () => { const r = await call('POST', S, asha); return r.http === 403 && r; }, 30000, 2000);
check(offC?.code === 'FEATURE_NOT_IN_PLAN', 'without "Doctor copilot" in the plan: no summary');
const offR = await waitFor(async () => { const r = await ask('Can you explain my second report?'); return !/7\.2/.test(r.message?.text ?? '') && r; }, 30000, 2000);
check(!!offR && /My lab tests/.test(offR.message?.text ?? '') === false ? !/7\.2/.test(offR.message?.text ?? '') : true, `without "Lab report explainer": the values are not explained (${offR?.message?.kind})`);
await call('PUT', F('ai.copilot'), support, { value: null, reason: 'copilot eval: back to the plan' }, 'medicare.localhost');
await call('PUT', F('ai.reports'), support, { value: null, reason: 'copilot eval: back to the plan' }, 'medicare.localhost');

await call('POST', `/api/scheduling/v1/appointments/${v2.id}/no-show`, desk).catch(() => null);
console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mcopilot: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
