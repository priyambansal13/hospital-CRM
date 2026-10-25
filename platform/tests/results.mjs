#!/usr/bin/env node
// Lab results and reports (Phase 15), against the local gateway:
//   results with reference-range flags (sex-specific) → a critical value alerts the ordering doctor first (email,
//   in-app value, acknowledge) → pathologist verifies → report PDF with QR verification, stored in the patient's
//   record → "report ready" (patient, doctor) → amendment = new version, old superseded → turnaround monitor.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host = 'citycare.localhost', extra = {}) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': host, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...j, status: r.status, _body: j };
}
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });
async function staffToken(email, slug = 'citycare') {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
let seq = 0;
async function patient(name) {
  const phone = `+9185${String(Date.now()).slice(-5)}${seq++ % 10}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  let code;
  for (let i = 0; i < 30 && !code; i++) { await sleep(200); code = (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6); }
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1970-01-15', gender: 'FEMALE' });
  return { token, phone, self };
}
const waitFor = async (fn, ms = 20000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
const pdfOf = async (path, token) => { const r = await fetch(G + path, { headers: { 'x-tenant-host': 'citycare.localhost', authorization: `Bearer ${token}` } }); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; };

// ---- setup: pathologist; Dr. Asha Rao orders CBC + FBS + Dengue for her patient; collected and in the lab
const admin = await staffToken('admin@citycare.test');
await call('POST', '/api/iam/v1/staff/invites', admin, { email: 'path@citycare.test', name: 'Dr. Prakash Path', roles: ['PATHOLOGIST'] }, undefined, idem());
await call('POST', '/api/iam/v1/staff/invites', admin, { email: 'lab@citycare.test', name: 'Lata Lab', roles: ['LAB_TECH'] }, undefined, idem());
await sleep(1500);
const [lab, path, desk, asha, other] = await Promise.all(['lab', 'path', 'desk', 'asha.rao', 'leak.doctor'].map((u) => staffToken(`${u}@citycare.test`)));
const P = await patient('Results Patient');
const cat = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
const T = (code) => cat.tests.find((t) => t.code === code);
const branch = (await call('GET', '/api/diagnostics/v1/public/lab-branches'))._body.find((b) => b.name === 'Sector 44');
const me = await call('GET', '/api/scheduling/v1/me/doctor', asha);
await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: P.self.id, walkIn: { doctorId: me.id, branchId: branch.id } }, undefined, idem());
const order = await waitFor(async () => { const r = await call('POST', '/api/diagnostics/v1/doctor/lab-orders', asha, { patientId: P.self.id, items: [{ testId: T('CBC').id }, { testId: T('FBS').id }, { testId: T('DENGUE_NS1').id }] }, undefined, idem()); return r.status === 201 && r; });
let slot;
for (let d = 1; d < 25 && !slot; d++) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + d * 86_400_000));
  slot = (await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${branch.id}&date=${day}`)).slots?.find((s) => s.left > 0);
}
await call('POST', `/api/diagnostics/v1/lab-orders/${order.id}/schedule`, P.token, { branchId: branch.id, slotAt: slot.slotAt, paymentMode: 'AT_CLINIC' });
psql(`UPDATE diagnostics.lab_orders SET slot_at = now() - interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id = '${order.id}'`);
await waitFor(async () => (await call('POST', '/api/billing/v1/desk/collect', lab, { sourceType: 'LAB_ORDER', sourceId: order.id, method: 'CASH' }, undefined, idem())).status === 201);
await waitFor(async () => (await call('GET', `/api/diagnostics/v1/lab-orders/${order.id}`, lab)).paymentStatus === 'PAID');
const o0 = await call('GET', `/api/diagnostics/v1/lab-orders/${order.id}`, lab);
for (const s of o0.samples) await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: s.barcode });
let inLab;
for (const s of o0.samples) inLab = await call('POST', '/api/diagnostics/v1/lab/samples/receive', lab, { barcode: s.barcode });
check(inLab._body.status === 'IN_LAB' && !!inLab.dueAt, `${order.orderNo} (CBC, FBS, Dengue NS1 for a woman) is in the lab; report due ${inLab.dueAt}`);

// ---- 1. the result sheet
const sheet = await call('GET', `/api/diagnostics/v1/lab/orders/${order.id}/results`, lab);
const cbc = sheet.tests.find((t) => t.code === 'CBC');
const hb = cbc.parameters.find((p) => p.parameter === 'Haemoglobin');
check(cbc.parameters.length === 3 && hb.refLow === 12 && hb.refHigh === 15, `CBC reports ${cbc.parameters.map((p) => p.parameter).join(', ')}; Hb range for a woman 12–15 g/dL`);
check((await call('GET', `/api/diagnostics/v1/lab-orders/${order.id}/results`, P.token)).code === 'NOT_READY', 'patient cannot see results before verification');
check((await call('GET', `/api/diagnostics/v1/lab/orders/${order.id}/results`, P.token)).status === 403, 'patients cannot open the lab result sheet');
const item = (code) => sheet.tests.find((t) => t.code === code).itemId;

// ---- 2. a critical value alerts the doctor first
const fbsEntered = await call('POST', `/api/diagnostics/v1/lab/orders/${order.id}/results`, lab, { results: [{ itemId: item('FBS'), parameter: 'Glucose, fasting', value: '452' }] });
const fbsRow = fbsEntered.tests?.find((t) => t.code === 'FBS').parameters[0];
check(fbsRow?.flag === 'CRITICAL_HIGH' && fbsEntered.order.status === 'IN_LAB', 'FBS 452 mg/dL → CRITICAL_HIGH (order still in the lab: other tests pending)');
const doctorAlerts = await waitFor(async () => { const a = await call('GET', '/api/diagnostics/v1/doctor/critical-alerts', asha); return a._body.find?.((x) => x.orderNo === order.orderNo) ; });
check(doctorAlerts?.value === '452' && doctorAlerts.unit === 'mg/dL' && !doctorAlerts.acknowledgedAt, `Dr. Asha Rao sees the critical value in the app: ${doctorAlerts?.test} ${doctorAlerts?.value} ${doctorAlerts?.unit}`);
const critMail = await waitFor(async () => (await mail('to:asha.rao@citycare.test subject:CRITICAL')).find((m) => m.Snippet.includes(order.orderNo)), 20000, 1000);
check(!!critMail && !critMail.Snippet.includes('452'), `email to the doctor (no value in the email): "${critMail?.Subject}"`);
check((await call('POST', `/api/diagnostics/v1/doctor/critical-alerts/${doctorAlerts.id}/ack`, other)).status === 404, 'another doctor cannot acknowledge it');
const ack = await call('POST', `/api/diagnostics/v1/doctor/critical-alerts/${doctorAlerts.id}/ack`, asha);
check(ack.acknowledged === true && !!(await call('GET', '/api/diagnostics/v1/doctor/critical-alerts', asha))._body.find((x) => x.id === doctorAlerts.id).acknowledgedAt, 'Dr. Asha Rao acknowledges');
const early = await call('GET', `/api/diagnostics/v1/doctor/lab-orders/${order.id}/results`, asha);
check(early.tests.find((t) => t.code === 'FBS').parameters[0].value === '452' && early.tests.find((t) => t.code === 'CBC').parameters.every((p) => p.value === null), 'before verification the doctor sees the critical value only');

// ---- 3. the rest, then verification
check((await call('POST', `/api/diagnostics/v1/lab/orders/${order.id}/results`, lab, { results: [{ itemId: item('CBC'), parameter: 'Cholesterol', value: '1' }] })).code === 'UNKNOWN_PARAMETER', 'a parameter the test does not report is refused');
const rest = await call('POST', `/api/diagnostics/v1/lab/orders/${order.id}/results`, lab, { results: [
  { itemId: item('CBC'), parameter: 'Haemoglobin', value: '11.2' }, { itemId: item('CBC'), parameter: 'WBC count', value: '7.5' }, { itemId: item('CBC'), parameter: 'Platelet count', value: '250' },
  { itemId: item('DENGUE_NS1'), parameter: 'Result', value: 'Positive' }] });
const flags = Object.fromEntries(rest.tests.flatMap((t) => t.parameters.map((p) => [p.parameter, p.flag])));
check(rest.order.status === 'RESULTS_ENTERED' && flags.Haemoglobin === 'LOW' && flags['WBC count'] === 'NORMAL' && flags.Result === 'ABNORMAL', `all entered → RESULTS_ENTERED (Hb 11.2 LOW for a woman, WBC normal, Dengue positive ABNORMAL)`);
check((await call('POST', `/api/diagnostics/v1/lab/orders/${order.id}/verify`, lab)).status === 403, 'a lab technician cannot verify (pathologist only)');
const v1 = await call('POST', `/api/diagnostics/v1/lab/orders/${order.id}/verify`, path);
check(v1.status === 201 && v1.version === 1 && v1.abnormal === 3 && v1.critical === 1 && !!v1.documentId, `pathologist verifies → report v1 (${v1.abnormal} abnormal, ${v1.critical} critical), stored in the patient's record`);
check((await call('POST', `/api/diagnostics/v1/lab/orders/${order.id}/results`, lab, { results: [{ itemId: item('CBC'), parameter: 'WBC count', value: '8' }] })).code === 'REPORT_PUBLISHED', 'results cannot be changed after publishing (only amended)');

// ---- 4. what the patient and doctor get
const mine = await call('GET', `/api/diagnostics/v1/lab-orders/${order.id}/results`, P.token);
check(mine.status === 200 && mine.tests.find((t) => t.code === 'FBS').parameters[0].flag === 'CRITICAL_HIGH', 'patient sees the verified results with flags');
const pdfP = await pdfOf(`/api/diagnostics/v1/lab-orders/${order.id}/report.pdf`, P.token);
check(pdfP.status === 200 && pdfP.bytes.subarray(0, 5).toString() === '%PDF-' && pdfP.bytes.length > 3000, `report PDF (${pdfP.bytes.length} bytes)`);
const docs = await call('GET', `/api/records/v1/patients/${P.self.id}/documents`, P.token);
check(docs._body.some((d) => d.id === v1.documentId && d.type === 'LAB_REPORT' && d.scanStatus === 'CLEAN'), 'the report is in the patient\'s documents (download link like any document)');
const tl = await call('GET', `/api/records/v1/patients/${P.self.id}/timeline?kind=REPORT`, P.token);
check(tl.items?.[0]?.summary?.critical === 1, `timeline: "${tl.items?.[0]?.title}" (${tl.items?.[0]?.summary?.abnormal} abnormal)`);
const sms = await waitFor(async () => (await mail(`to:${P.phone.slice(1)}@sms.medicare.local`)).find((m) => m.Snippet.includes(order.orderNo) && /new document/.test(m.Snippet)), 20000, 1000);
check(!!sms && !/452|glucose|dengue|positive/i.test(sms.Snippet), `patient SMS has no results: "${sms?.Snippet.slice(0, 90)}…"`);
check(!!(await waitFor(async () => (await mail('to:asha.rao@citycare.test subject:"Report ready"')).find((m) => (m.Subject ?? '').includes(order.orderNo)), 20000, 1000)), 'ordering doctor gets "report ready" by email');
check((await pdfOf(`/api/diagnostics/v1/lab-orders/${order.id}/report.pdf`, other)).status === 404, 'a doctor without access cannot get the PDF');

// ---- 5. QR verification (public)
const code = (await call('GET', `/api/diagnostics/v1/lab/orders/${order.id}/results`, lab)).reports[0].verifyCode;
const ver = await call('GET', `/api/diagnostics/v1/public/lab-reports/verify/${code}`);
check(ver.valid && ver.current && ver.orderNo === order.orderNo && ver.patient === 'R. P.' && !JSON.stringify(ver).includes('Results Patient'), `QR check: genuine, current, patient "${ver.patient}" (no full name, no results)`);
check((await call('GET', '/api/diagnostics/v1/public/lab-reports/verify/ZZZZZZZZ')).status === 404, 'a made-up code is not found');

// ---- 6. amendment
check((await call('POST', `/api/diagnostics/v1/lab/orders/${order.id}/amend`, lab, { reason: 'Transcription error', results: [{ itemId: item('FBS'), parameter: 'Glucose, fasting', value: '152' }] })).status === 403, 'only a pathologist can amend');
const v2 = await call('POST', `/api/diagnostics/v1/lab/orders/${order.id}/amend`, path, { reason: 'Transcription error: 152 was entered as 452', results: [{ itemId: item('FBS'), parameter: 'Glucose, fasting', value: '152' }] });
check(v2.status === 201 && v2.version === 2 && v2.critical === 0 && v2.documentId !== v1.documentId, `amended → report v2 (0 critical), new document`);
check((await call('GET', `/api/diagnostics/v1/public/lab-reports/verify/${code}`)).current === false, 'the v1 QR code now says "superseded"');
const docs2 = await call('GET', `/api/records/v1/patients/${P.self.id}/documents`, P.token);
check(!docs2._body.some((d) => d.id === v1.documentId) && docs2._body.some((d) => d.id === v2.documentId), 'the patient\'s documents show only the current version');
check(psql(`SELECT count(*) FROM diagnostics.lab_result_history h JOIN diagnostics.lab_results r ON r.id = h.result_id WHERE r.order_id = '${order.id}' AND h.value = '452'`) === '1', 'the corrected value is kept in the result history');
check(!!(await waitFor(async () => (await mail(`to:${P.phone.slice(1)}@sms.medicare.local`)).find((m) => m.Snippet.includes('(updated)')), 20000, 1000)), 'patient told about the updated version');

// ---- 7. turnaround monitor
const o2 = await waitFor(async () => { const r = await call('POST', '/api/diagnostics/v1/doctor/lab-orders', asha, { patientId: P.self.id, items: [{ testId: T('ESR').id }] }, undefined, idem()); return r.status === 201 && r; });
psql(`UPDATE diagnostics.lab_orders SET status = 'IN_LAB', branch_id = '${branch.id}', slot_at = now() - interval '3 hours', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date, collected_at = now() - interval '7 hours', due_at = now() - interval '1 hour' WHERE id = '${o2.id}'`);
const overdue = await waitFor(async () => (await call('GET', `/api/diagnostics/v1/lab/pending?branchId=${branch.id}`, lab))._body.find?.((x) => x.id === o2.id && x.overdue), 90000, 3000);
check(!!overdue, 'turnaround monitor flags an order past its due time (overdue, listed first)');

// ---- 8. audit
const log = await call('GET', `/api/audit/v1/audit?patientId=${P.self.id}`, admin);
const actions = new Set(log.items?.map((e) => `${e.action}:${e.resourceType}`));
check(['UPDATE:LAB_RESULTS', 'SIGN:LAB_REPORT', 'AMEND:LAB_REPORT', 'UPDATE:CRITICAL_ALERT'].every((a) => actions.has(a)), `audited: ${[...actions].filter((a) => /LAB|CRITICAL/.test(a)).join(', ')}`);

console.log(failures ? `\x1b[31m${failures} failure(s)\x1b[0m` : '\x1b[32mresults ok\x1b[0m');
process.exit(failures ? 1 : 0);
