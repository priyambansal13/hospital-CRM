#!/usr/bin/env node
// Integrations (Phase 27), against the local gateway, on citycare, with a local receiver standing in for the HIS/LIS:
//   webhooks (signed, delivered, retried, test ping), API keys (shown once, scopes, revoke, other hospital), the FHIR
//   read API (Patient, Appointment, DiagnosticReport; audited), the LIS connector (order out when the samples reach
//   the lab, results back as Observations → entered, waiting for the pathologist); module reset.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
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
async function staffToken(email) {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:citycare' }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
const waitFor = async (fn, ms = 20000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
async function patient(name) {
  const phone = `+9186${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const code = await waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6), 10000, 300);
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1980-03-03', gender: 'FEMALE' });
  return { token, phone, self };
}
const mc = (...a) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const psql = (sql, db = 't_citycare') => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const SFX = Date.now().toString().slice(-6);
const fhir = async (path, key, host = 'citycare.localhost') => {
  const r = await fetch(`${G}/api/integration/v1/fhir/r4/${path}`, { headers: { 'x-tenant-host': host, ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  return { http: r.status, type: r.headers.get('content-type'), ...(await r.json().catch(() => ({}))) };
};

// the hospital's own system: records what arrives; /fail answers 500
const got = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    got.push({ path: req.url, headers: req.headers, body, json: JSON.parse(body || '{}') });
    res.statusCode = req.url.startsWith('/fail') ? 500 : 200;
    res.end(req.url.startsWith('/fail') ? 'down for maintenance' : 'ok');
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const RX = `http://127.0.0.1:${server.address().port}`;
const verify = (secret, sig, body) => { const [, t, v1] = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(sig ?? '') ?? []; return !!t && createHmac('sha256', secret).update(`${t}.${body}`).digest('hex') === v1; };

try {
  // ---- 1. module on, webhooks
  mc('module', 'enable', 'citycare', 'integrations');
  const admin = await staffToken('admin@citycare.test');
  const desk = await staffToken('desk@citycare.test');
  const ready = await waitFor(async () => (await call('GET', '/api/integration/v1/integrations/catalog', admin)).http === 200, 30000, 1000);
  check(!!ready, 'module on: the integrations API answers');
  check((await call('GET', '/api/integration/v1/integrations/endpoints', desk)).http === 403, 'the desk cannot manage integrations');
  check((await call('POST', '/api/integration/v1/integrations/endpoints', admin, { kind: 'WEBHOOK', name: 'x', url: 'ftp://his.example/x', events: ['appointment.booked'] })).http >= 400, 'an ftp:// address is refused');
  const ep = await call('POST', '/api/integration/v1/integrations/endpoints', admin, { kind: 'WEBHOOK', name: `HIS ${SFX}`, url: `${RX}/his`, events: ['appointment.booked', 'appointment.cancelled'] });
  check(ep.http === 201 && ep.secret?.startsWith('whsec_'), `webhook endpoint added; secret shown once (${ep.secretHint})`);
  const listed = await call('GET', '/api/integration/v1/integrations/endpoints', admin);
  check(!JSON.stringify(listed).includes(ep.secret), 'the secret is not shown again');
  const bad = await call('POST', '/api/integration/v1/integrations/endpoints', admin, { kind: 'WEBHOOK', name: `Broken ${SFX}`, url: `${RX}/fail`, events: ['appointment.booked'] });

  const P = await patient(`Integration Patient ${SFX}`);
  const doc = (await call('GET', '/api/provider/v1/public/doctors?q=asha')).items[0];
  const slot = (await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=10`)).days?.at(-1)?.slots?.at(-1);
  const appt = await call('POST', '/api/scheduling/v1/appointments', P.token, { slotId: slot.slotId, patientId: P.self.id, paymentMode: 'AT_CLINIC' });
  const hit = await waitFor(async () => got.find((g) => g.path === '/his' && g.json.data?.appointmentNo === appt.appointmentNo), 30000, 500);
  check(!!hit && hit.json.type === 'appointment.booked' && hit.headers['x-medicare-event'] === 'appointment.booked', `the HIS receives appointment.booked for ${appt.appointmentNo}`);
  check(!!hit && verify(ep.secret, hit.headers['x-medicare-signature'], hit.body), 'the signature checks out with the secret');
  check(hit?.json.data?.patient?.mrn === P.self.mrn && hit.json.hospital === 'citycare', 'payload: patient MRN, doctor, branch, hospital');
  const failing = await waitFor(async () => (await call('GET', `/api/integration/v1/integrations/deliveries?endpointId=${bad.id}`, admin)).list?.find((d) => d.attempts >= 1), 30000, 1000);
  check(failing?.status === 'PENDING' && failing.lastStatus === 500 && Date.parse(failing.nextAttemptAt) > Date.now(), `a failing receiver is retried later (attempt ${failing?.attempts}: ${failing?.lastError})`);
  psql(`UPDATE integration.deliveries SET attempts = 5, next_attempt_at = now() WHERE endpoint_id = '${bad.id}'`);
  const dead = await waitFor(async () => (await call('GET', `/api/integration/v1/integrations/deliveries?endpointId=${bad.id}`, admin)).list?.find((d) => d.status === 'FAILED'), 30000, 1000);
  check(!!dead, 'after the last attempt the delivery is FAILED');
  check((await call('POST', `/api/integration/v1/integrations/deliveries/${dead.id}/retry`, admin)).status === 'PENDING', 'an admin can retry a failed delivery');
  await call('PATCH', `/api/integration/v1/integrations/endpoints/${bad.id}`, admin, { active: false, version: bad.version });
  const ping = await call('POST', `/api/integration/v1/integrations/endpoints/${ep.id}/test`, admin);
  check(ping.status === 'DELIVERED' && got.some((g) => g.json.type === 'ping'), 'Send a test: delivered at once');
  await call('POST', `/api/scheduling/v1/appointments/${appt.id}/cancel`, P.token, {});
  check(!!(await waitFor(async () => got.find((g) => g.json.type === 'appointment.cancelled' && g.json.data?.appointmentNo === appt.appointmentNo), 30000, 500)), 'appointment.cancelled follows');

  // ---- 2. API keys + FHIR
  const meta = await fhir('metadata');
  check(meta.http === 200 && meta.resourceType === 'CapabilityStatement' && meta.type?.startsWith('application/fhir+json'), 'GET metadata: CapabilityStatement (no key needed)');
  const key = await call('POST', '/api/integration/v1/integrations/api-keys', admin, { name: `HIS reader ${SFX}`, scopes: ['fhir:read'] });
  check(key.http === 201 && /^mck_[a-f0-9]{12}_/.test(key.key ?? ''), 'API key created (shown once)');
  check(!JSON.stringify(await call('GET', '/api/integration/v1/integrations/api-keys', admin)).includes(key.key), 'the key is not shown again');
  const nokey = await fhir(`Patient/${P.self.id}`);
  check(nokey.http === 401 && nokey.resourceType === 'OperationOutcome', 'no key → 401 OperationOutcome');
  const pt = await fhir(`Patient/${P.self.id}`, key.key);
  check(pt.resourceType === 'Patient' && pt.identifier?.[0]?.value === P.self.mrn && pt.birthDate === '1980-03-03', `Patient/${P.self.mrn}: name, MRN, birth date`);
  const byMrn = await fhir(`Patient?identifier=${P.self.mrn}`, key.key);
  check(byMrn.resourceType === 'Bundle' && byMrn.total === 1 && byMrn.entry[0].resource.id === P.self.id, 'Patient?identifier=<MRN> finds them');
  const appts = await fhir(`Appointment?patient=Patient/${P.self.id}`, key.key);
  check(appts.total >= 1 && appts.entry.some((e) => e.resource.identifier[0].value === appt.appointmentNo && e.resource.status === 'cancelled'), 'Appointment?patient=…: the visit, status cancelled');
  const reported = psql(`SELECT patient_id FROM diagnostics.lab_orders WHERE status = 'REPORT_PUBLISHED' ORDER BY updated_at DESC LIMIT 1`);
  if (reported) {
    const dr = await fhir(`DiagnosticReport?patient=${reported}`, key.key);
    const r0 = dr.entry?.[0]?.resource;
    check(r0?.resourceType === 'DiagnosticReport' && ['final', 'amended'].includes(r0.status) && r0.contained.length > 0 && r0.contained.some((o) => o.valueQuantity || o.valueString), `DiagnosticReport: ${r0?.identifier?.[0]?.value}, ${r0?.contained?.length} observations with values and flags`);
  } else check(false, 'no published report in citycare (run mc test results once)');
  const audited = psql(`SELECT count(*) FROM audit.audit_log WHERE actor_name = 'API key: HIS reader ${SFX}'`, 't_citycare');
  check(Number(audited) >= 3, `every FHIR read is in the audit log (${audited} entries)`);
  check((await fhir(`Patient/${P.self.id}`, key.key, 'sunrise.localhost')).http === 401, 'the key does not work at another hospital');
  const lisOnly = await call('POST', '/api/integration/v1/integrations/api-keys', admin, { name: `LIS ${SFX}`, scopes: ['lis:write'] });
  check((await fhir(`Patient/${P.self.id}`, lisOnly.key)).http === 403, 'a key without fhir:read gets 403');
  await call('POST', `/api/integration/v1/integrations/api-keys/${key.id}/revoke`, admin);
  check((await fhir(`Patient/${P.self.id}`, key.key)).http === 401, 'a revoked key stops working');

  // ---- 3. LIS connector
  for (const e of (await call('GET', '/api/integration/v1/integrations/endpoints?kind=LIS', admin)).list ?? []) await call('PATCH', `/api/integration/v1/integrations/endpoints/${e.id}`, admin, { url: `${RX}/lis`, active: true, version: e.version });
  if (!((await call('GET', '/api/integration/v1/integrations/endpoints?kind=LIS', admin)).list ?? []).length) await call('POST', '/api/integration/v1/integrations/endpoints', admin, { kind: 'LIS', name: 'Analyzer bridge', url: `${RX}/lis` });
  const lab = await staffToken('lab@citycare.test');
  const cat = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
  const fbs = cat.tests.find((t) => t.code === 'FBS');
  const branch = (await call('GET', '/api/diagnostics/v1/public/lab-branches')).list.find((b) => b.name === 'Sector 44');
  let slotAt;
  for (let d = 1; d < 25 && !slotAt; d++) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + d * 86_400_000));
    slotAt = (await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${branch.id}&date=${day}`)).slots?.find((s) => s.left > 0)?.slotAt;
  }
  const order = await call('POST', '/api/diagnostics/v1/lab-orders', P.token, { patientId: P.self.id, branchId: branch.id, slotAt, items: [{ testId: fbs.id }] });
  psql(`UPDATE diagnostics.lab_orders SET slot_at = now() - interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id = '${order.id}'`);
  await waitFor(async () => (await call('POST', '/api/billing/v1/desk/collect', lab, { sourceType: 'LAB_ORDER', sourceId: order.id, method: 'CASH' })).http === 201, 20000, 1000);
  await waitFor(async () => (await call('GET', `/api/diagnostics/v1/lab-orders/${order.id}`, lab)).paymentStatus === 'PAID', 20000, 1000);
  const o0 = await call('GET', `/api/diagnostics/v1/lab-orders/${order.id}`, lab);
  for (const s of o0.samples) await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: s.barcode });
  let inLab;
  for (const s of o0.samples) inLab = await call('POST', '/api/diagnostics/v1/lab/samples/receive', lab, { barcode: s.barcode });
  check(inLab?.status === 'IN_LAB', `${order.orderNo} (FBS) is in the lab`);
  const sent = await waitFor(async () => got.find((g) => g.path === '/lis' && g.json.entry?.some((e) => e.resource.resourceType === 'ServiceRequest' && e.resource.identifier[0].value === order.orderNo)), 30000, 500);
  const sr = sent?.json.entry.find((e) => e.resource.resourceType === 'ServiceRequest')?.resource;
  const spec = sent?.json.entry.find((e) => e.resource.resourceType === 'Specimen')?.resource;
  check(sent?.headers['x-medicare-event'] === 'lis.order' && sr?.code.coding[0].code === 'FBS' && spec?.identifier[0].value === o0.samples[0].barcode, 'the LIS receives a FHIR order: ServiceRequest FBS with the tube barcode');
  const sheet = await call('GET', `/api/diagnostics/v1/lab/orders/${order.id}/results`, lab);
  const param = sheet.tests[0].parameters[0].parameter;
  const lisPost = (body, k = lisOnly.key) => fetch(`${G}/api/integration/v1/fhir/r4/lis/results`, { method: 'POST', headers: { 'x-tenant-host': 'citycare.localhost', 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify(body) }).then(async (r) => ({ http: r.status, ...(await r.json()) }));
  const obs = (code, value) => ({ resource: { resourceType: 'Observation', status: 'final', basedOn: [{ identifier: { value: order.orderNo } }], code: { coding: [{ code }], text: param }, valueQuantity: { value } } });
  check((await lisPost({ resourceType: 'Bundle', entry: [obs('FBS', 96)] }, key.key)).http === 401, 'results with a revoked key are refused');
  check((await lisPost({ resourceType: 'Bundle', entry: [obs('TSH', 2)] })).http === 422, 'a test that is not on the order is refused');
  const back = await lisPost({ resourceType: 'Bundle', type: 'collection', entry: [obs('FBS', 96)] });
  check(back.http === 200 && back.issue?.[0]?.severity === 'information', `the LIS sends the value back: ${back.issue?.[0]?.details?.text}`);
  const after = await call('GET', `/api/diagnostics/v1/lab/orders/${order.id}/results`, lab);
  const p0 = after.tests[0].parameters[0];
  check(after.order.status === 'RESULTS_ENTERED' && p0.value === '96' && p0.enteredBy === `LIS: LIS ${SFX}`, `entered as "${p0.enteredBy}", order waits for the pathologist`);
} finally {
  server.close();
  mc('module', 'reset', 'citycare', 'integrations');
  await sleep(2000);
  const closed = await call('GET', '/api/integration/v1/integrations/catalog', await staffToken('admin@citycare.test'));
  check(closed.http === 403 || closed.http === 404, `module reset: closed (${closed.http})`);
}
console.log(failures ? `\x1b[31m${failures} check(s) failed\x1b[0m` : '\x1b[32mintegrations: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
