#!/usr/bin/env node
// Cross-tenant leak test (docs/IMPLEMENTATION-PLAN.md, definition of done). Runs against the local gateway with two
// hospitals (citycare, sunrise) and every route of every service, discovered from GET /internal/routes:
//   1. every 'auth' route rejects a token issued for another hospital (401/403) and a missing token (401)
//   2. every 'auth' route with path params, called by sunrise with CITYCARE's ids, returns 404/403 (never 2xx)
//   3. every param-less GET, called by sunrise, never returns citycare's data
//   4. 'tenant-public' routes never return the other hospital's data
//   5. /internal routes are not reachable through the gateway
// A new route with path params and no fixture below FAILS the test: add the fixture when you add the route.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { services } from '../scripts/mc.mjs';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const GW = process.env.GATEWAY_URL ?? 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const A = 'citycare';
const B = 'sunrise';

let failures = 0;
let checks = 0;
const fail = (msg) => { failures++; console.log(`  \x1b[31m✗ ${msg}\x1b[0m`); };
const ok = () => { checks++; };

async function staffToken(email, slug) {
  const r = await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function patientToken(slug, phone) {
  const host = `${slug}.localhost`;
  const since = Date.now() - 1000;
  await call('POST', '/api/iam/v1/auth/otp/request', { host, body: { phone } });
  // the code sent just now for this hospital (the same phone also gets appointment SMS with 6-digit numbers in them);
  // polled, since SMS delivery can lag under load and an older code would be picked up
  let code;
  for (let i = 0; i < 40 && !code; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.replace('+', '')}@sms.medicare.local`)}`)).json();
    code = s.messages.find((m) => Date.parse(m.Created) >= since && /^\d{6} is your .* login code/.test(m.Snippet) && m.Snippet.includes(slug === A ? 'CityCare' : 'Sunrise'))?.Snippet.match(/^(\d{6})/)?.[1];
  }
  const r = await call('POST', '/api/iam/v1/auth/otp/verify', { host, body: { phone, code } });
  if (!r.json?.accessToken) throw new Error(`otp ${slug}: ${r.status} ${r.text}`);
  return r.json.accessToken;
}

async function call(method, path, { host, token, body } = {}) {
  const payload = body === undefined ? (['POST', 'PUT', 'PATCH'].includes(method) ? '{}' : undefined) : JSON.stringify(body);
  const headers = payload === undefined ? {} : { 'content-type': 'application/json' };
  if (host) headers['x-tenant-host'] = host;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(GW + path, { method, headers, body: payload });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

const main = async () => {
  console.log('setting up tokens and fixtures…');
  const tok = { A: await staffToken(`admin@${A}.test`, A), B: await staffToken(`admin@${B}.test`, B) };
  const pat = { A: await patientToken(A, '+919800000001'), B: await patientToken(B, '+919800000002') };
  const me = (await call('GET', '/api/iam/v1/me', { host: `${A}.localhost`, token: tok.A })).json;
  let branch = (await call('GET', '/api/tenant/v1/branches', { host: `${A}.localhost`, token: tok.A })).json?.find((b) => b.active);
  if (!branch) branch = (await call('POST', '/api/tenant/v1/branches', { host: `${A}.localhost`, token: tok.A, body: { name: 'Leak Test Branch', city: 'Delhi' } })).json;

  // a published doctor at citycare (directory module)
  const spec = (await call('GET', '/api/provider/v1/specialties', { host: `${A}.localhost`, token: tok.A })).json?.[0];
  let doctor = (await call('GET', '/api/provider/v1/doctors?q=Leak', { host: `${A}.localhost`, token: tok.A })).json?.items?.[0];
  if (!doctor) {
    doctor = (await call('POST', '/api/provider/v1/doctors', { host: `${A}.localhost`, token: tok.A, body: {
      name: 'Dr. Leak Test', email: 'leak.doctor@citycare.test', registrationNo: 'LEAK/0001',
      specialties: [{ code: spec.code, primary: true }], branches: [{ branchId: branch.id, fee: 700 }] } })).json;
    await call('POST', `/api/provider/v1/doctors/${doctor.id}/status`, { host: `${A}.localhost`, token: tok.A, body: { status: 'ACTIVE' } });
  }
  // scheduling: weekly hours + a leave for the citycare doctor (the doctor reaches scheduling-service via events)
  let sched;
  for (let i = 0; i < 20 && !sched?.doctor; i++) {
    sched = (await call('GET', `/api/scheduling/v1/doctors/${doctor.id}/schedule`, { host: `${A}.localhost`, token: tok.A })).json;
    if (!sched?.doctor) await new Promise((r) => setTimeout(r, 500));
  }
  let hours = sched?.hours?.[0];
  if (!hours) {
    await call('POST', `/api/scheduling/v1/doctors/${doctor.id}/availability`, { host: `${A}.localhost`, token: tok.A, body: { days: [7], branchId: branch.id, startTime: '08:00', endTime: '09:00', slotMinutes: 30 } });
    sched = (await call('GET', `/api/scheduling/v1/doctors/${doctor.id}/schedule`, { host: `${A}.localhost`, token: tok.A })).json;
    hours = sched.hours[0];
  }
  let leave = sched.leaves.find((l) => l.reason === 'leak-test');
  if (!leave) {
    const r = (await call('POST', `/api/scheduling/v1/doctors/${doctor.id}/leaves`, { host: `${A}.localhost`, token: tok.A, body: { fromDate: '2027-12-30', toDate: '2027-12-31', reason: 'leak-test' } })).json;
    leave = { id: r.leaveId };
  }
  // a citycare patient with a family member, a booked appointment and a waitlist entry
  const PA = { host: `${A}.localhost`, token: pat.A };
  let fam = (await call('GET', '/api/patient/v1/me/patients', PA)).json;
  if (!fam?.find((p) => p.isSelf)) await call('PUT', '/api/patient/v1/me/profile', { ...PA, body: { fullName: 'Leak Patient', dob: '1985-05-05' } });
  if (!fam?.find((p) => !p.isSelf)) await call('POST', '/api/patient/v1/me/dependents', { ...PA, body: { fullName: 'Leak Child', dob: '2016-02-02', relation: 'CHILD' } });
  fam = (await call('GET', '/api/patient/v1/me/patients', PA)).json;
  const selfP = fam.find((p) => p.isSelf);
  const child = fam.find((p) => !p.isSelf);
  let appt = (await call('GET', '/api/scheduling/v1/me/appointments', PA)).json?.upcoming?.[0];
  const openSlot = (await call('GET', `/api/scheduling/v1/public/doctors/${doctor.id}/slots?days=60`, { host: `${A}.localhost` })).json?.days?.at(-1)?.slots?.[0];
  if (!appt) appt = (await call('POST', '/api/scheduling/v1/appointments', { ...PA, body: { slotId: openSlot.slotId, patientId: selfP.id } })).json;
  let wait = (await call('GET', '/api/scheduling/v1/me/waitlist', PA)).json?.[0];
  if (!wait) wait = (await call('POST', '/api/scheduling/v1/waitlist', { ...PA, body: { doctorId: doctor.id, date: '2027-06-01', patientId: child.id } })).json;
  const slot = (await call('GET', `/api/scheduling/v1/public/doctors/${doctor.id}/slots?days=60`, { host: `${A}.localhost` })).json?.days?.at(-1)?.slots?.at(-1);

  // an invoice (billing creates one from a pay-at-hospital booking's event)
  let invoice = (await call('GET', '/api/billing/v1/me/invoices', PA)).json?.[0];
  if (!invoice) {
    const s2 = (await call('GET', `/api/scheduling/v1/public/doctors/${doctor.id}/slots?days=60`, { host: `${A}.localhost` })).json?.days?.at(-2)?.slots?.[0];
    await call('POST', '/api/scheduling/v1/appointments', { ...PA, body: { slotId: s2.slotId, patientId: selfP.id } });
    for (let i = 0; i < 40 && !invoice; i++) { await new Promise((r) => setTimeout(r, 250)); invoice = (await call('GET', '/api/billing/v1/me/invoices', PA)).json?.[0]; }
  }

  // a visit and a prescription (clinical data is not readable by the admin through the API; ids come from the DB)
  const psql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', `t_${A}`, '-c', sql], { encoding: 'utf8' }).trim();
  const [encId, encAppt, encPatient] = psql(`SELECT id || '|' || coalesce(appointment_id::text, '') || '|' || patient_id FROM records.encounters ORDER BY started_at LIMIT 1`).split('|');
  const rxId = psql('SELECT id FROM records.prescriptions ORDER BY issued_at LIMIT 1');
  if (!encId || !rxId) throw new Error('fixture setup failed: no encounter/prescription in citycare yet — run `mc test records` once');
  const encounter = { id: encId, appointmentId: encAppt, patientId: encPatient };
  const docId = psql(`SELECT id FROM records.medical_documents WHERE scan_status = 'CLEAN' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`);
  const consentId = psql('SELECT id FROM patient.consents ORDER BY valid_from LIMIT 1');
  const [allergyId, allergyPatient] = psql('SELECT id || \'|\' || patient_id FROM patient.allergies WHERE removed_at IS NULL ORDER BY created_at LIMIT 1').split('|');
  const labOrderId = psql(`SELECT id FROM diagnostics.lab_orders ORDER BY created_at LIMIT 1`);
  const labTestId = psql(`SELECT id FROM diagnostics.lab_tests ORDER BY code LIMIT 1`);
  const labPackageId = psql(`SELECT id FROM diagnostics.lab_packages ORDER BY code LIMIT 1`);
  if (!labOrderId) throw new Error('fixture setup failed: no lab order in citycare yet — run `mc test lab` once');
  const reportOrderId = psql(`SELECT order_id FROM diagnostics.lab_reports ORDER BY verified_at LIMIT 1`);
  const alertId = psql(`SELECT id FROM diagnostics.critical_alerts ORDER BY created_at LIMIT 1`);
  const verifyCode = psql(`SELECT verify_code FROM diagnostics.lab_reports ORDER BY verified_at LIMIT 1`);
  if (!reportOrderId || !alertId) throw new Error('fixture setup failed: no lab report / critical alert in citycare yet — run `mc test results` once');
  const visitId = psql(`SELECT id FROM diagnostics.home_visits ORDER BY updated_at LIMIT 1`);
  const phlebId = psql(`SELECT user_id FROM diagnostics.phlebotomists ORDER BY created_at LIMIT 1`);
  // platform console (only MediCare HQ may use it): a real plan version and citycare's own id
  const controlPsql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 'mc_control', '-c', sql], { encoding: 'utf8' }).trim();
  const planVersionId = controlPsql(`SELECT v.id FROM subscription.plan_versions v JOIN subscription.plans p ON p.id = v.plan_id WHERE p.code = 'HOSPITAL_PRO' ORDER BY v.version LIMIT 1`);
  const cityId = controlPsql(`SELECT id FROM tenant.tenants WHERE slug = '${A}'`);
  // a custom role only citycare has (role routes take a role code, not an id)
  await call('POST', '/api/entitlement/v1/roles', { host: `${A}.localhost`, token: tok.A, body: { code: 'LEAK_ROLE', name: 'Leak test role', copyFrom: null } });
  // an invoice of another hospital (greenleaf, from mc test billing / plans; any hospital but sunrise will do)
  const foreignInvoice = controlPsql(`SELECT i.id FROM subscription.saas_invoices i JOIN tenant.tenants t ON t.id = i.tenant_id WHERE t.slug <> '${B}' ORDER BY i.created_at LIMIT 1`) || '00000000-0000-4000-8000-000000000000';
  if (!visitId || !phlebId) throw new Error('fixture setup failed: no home visit / phlebotomist in citycare yet — run `mc test home` once');
  if (!docId || !consentId || !allergyId) throw new Error('fixture setup failed: no document/consent/allergy in citycare yet — run `mc test documents` once');

  const template = (await call('GET', '/api/notification/v1/notification-templates', { host: `${A}.localhost`, token: tok.A })).json?.find((t) => t.key === 'reminder_2h' && t.language === 'en');
  for (const [what, v] of [['branch', branch], ['specialty', spec], ['doctor', doctor], ['hours', hours], ['leave', leave], ['patient', selfP], ['dependent', child], ['appointment', appt], ['waitlist', wait], ['slot', slot && { id: slot.slotId }], ['template', template], ['invoice', invoice]]) if (!v?.id) throw new Error(`fixture setup failed: ${what} = ${JSON.stringify(v)}`);

  // Values that must never appear in a response to the other hospital.
  // AI assistant (run `mc test assistant` once): a CityCare chat, answer, chat request and knowledge article
  const [aiConv, aiMsg] = psql(`SELECT c.id || '|' || m.id FROM assistant.conversations c JOIN assistant.messages m ON m.conversation_id = c.id AND m.role = 'assistant' ORDER BY c.created_at, m.seq LIMIT 1`).split('|');
  const aiHandoff = psql(`SELECT id FROM assistant.handoffs ORDER BY created_at LIMIT 1`);
  const [aiArticle, aiArticleTitle] = psql(`SELECT id || '|' || title FROM assistant.kb_articles WHERE source = 'FAQ' AND source_ref = 'parking'`).split('|');
  const secrets = [aiConv, aiMsg, aiHandoff, aiArticle, me.id, me.tenant.id, branch.id, branch.name, 'CityCare', doctor.id, doctor.name, spec.id, hours.id, leave.id, selfP.id, selfP.mrn, child.id, 'Leak Patient', appt.id, appt.appointmentNo, wait.id, invoice.id, invoice.invoiceNo, encounter.id, rxId, docId, consentId, allergyId, labOrderId, reportOrderId, verifyCode, visitId];
  // Path params → citycare's ids. key: "<route prefix>:<METHOD> <path>"
  const fixtures = {
    'tenant:GET /v1/branches/:id': { id: branch.id },
    'tenant:PATCH /v1/branches/:id': { id: branch.id, body: { name: 'pwned', version: 0 } },
    'entitlement:GET /v1/users/:userId/roles': { userId: me.id },
    'entitlement:POST /v1/users/:userId/roles': { userId: me.id, body: { roleCode: 'DOCTOR' } },
    'entitlement:DELETE /v1/users/:userId/roles/:roleCode': { userId: me.id, roleCode: 'TENANT_ADMIN' },
    'provider:GET /v1/doctors/:id': { id: doctor.id },
    'provider:PATCH /v1/doctors/:id': { id: doctor.id, body: { name: 'pwned', version: 0 } },
    'provider:POST /v1/doctors/:id/status': { id: doctor.id, body: { status: 'INACTIVE' } },
    'provider:PATCH /v1/specialties/:id': { id: spec.id, body: { name: 'pwned' } },
    'provider:GET /v1/public/doctors/:id': { id: doctor.id },
    'scheduling:GET /v1/doctors/:doctorId/schedule': { doctorId: doctor.id },
    'scheduling:GET /v1/doctors/:doctorId/slots': { doctorId: doctor.id },
    'scheduling:POST /v1/doctors/:doctorId/availability': { doctorId: doctor.id, body: { days: [1], branchId: branch.id, startTime: '20:00', endTime: '21:00', slotMinutes: 30 } },
    'scheduling:DELETE /v1/doctors/:doctorId/availability/:templateId': { doctorId: doctor.id, templateId: hours.id },
    'scheduling:POST /v1/doctors/:doctorId/leaves': { doctorId: doctor.id, body: { fromDate: '2027-01-01', toDate: '2027-01-02' } },
    'scheduling:DELETE /v1/doctors/:doctorId/leaves/:leaveId': { doctorId: doctor.id, leaveId: leave.id },
    'scheduling:GET /v1/public/doctors/:doctorId/slots': { doctorId: doctor.id },
    'scheduling:GET /v1/public/slots/:slotId': { slotId: slot.slotId },
    'scheduling:GET /v1/appointments/:id': { id: appt.id },
    'scheduling:POST /v1/appointments/:id/cancel': { id: appt.id, body: {} },
    'scheduling:POST /v1/appointments/:id/reschedule': { id: appt.id, body: { newSlotId: slot.slotId } },
    'scheduling:DELETE /v1/waitlist/:id': { id: wait.id },
    'scheduling:GET /v1/doctors/:doctorId/appointments': { doctorId: doctor.id },
    'scheduling:GET /v1/doctors/:doctorId/queue': { doctorId: doctor.id },
    'scheduling:GET /v1/desk/doctors/:doctorId/slots': { doctorId: doctor.id, query: `?branchId=${branch.id}` },
    'scheduling:POST /v1/desk/appointments/:id/check-in': { id: appt.id, body: {} },
    'scheduling:POST /v1/appointments/:id/start': { id: appt.id, body: {} },
    'scheduling:POST /v1/appointments/:id/complete': { id: appt.id, body: {} },
    'scheduling:POST /v1/appointments/:id/no-show': { id: appt.id, body: {} },
    'patient:GET /v1/desk/patients/:id': { id: selfP.id },
    'billing:GET /v1/invoices/:id': { id: invoice.id },
    'records:GET /v1/encounters/:id': { id: encounter.id },
    'records:PATCH /v1/encounters/:id': { id: encounter.id, body: { version: 0, notes: 'pwned' } },
    'records:POST /v1/encounters/:id/sign': { id: encounter.id, body: { version: 0 } },
    'records:POST /v1/encounters/:id/amendments': { id: encounter.id, body: { reason: 'pwned amendment', notes: 'pwned' } },
    'records:POST /v1/encounters/:id/prescriptions': { id: encounter.id, body: { items: [{ drugName: 'pwned', dosage: '1-0-1' }] } },
    'records:GET /v1/encounters/by-appointment/:appointmentId': { appointmentId: encounter.appointmentId },
    'records:GET /v1/patients/:patientId/chart': { patientId: encounter.patientId },
    'records:POST /v1/patients/:patientId/break-glass': { patientId: encounter.patientId, body: { reason: 'pwned emergency access attempt' } },
    'records:GET /v1/prescriptions/:id': { id: rxId },
    'records:GET /v1/prescriptions/:id/pdf': { id: rxId },
    'records:GET /v1/documents/:id': { id: docId },
    'records:GET /v1/documents/:id/download': { id: docId },
    'records:DELETE /v1/documents/:id': { id: docId },
    'records:GET /v1/patients/:patientId/documents': { patientId: encounter.patientId },
    'records:POST /v1/patients/:patientId/documents': { patientId: encounter.patientId, body: { uploadId: '00000000-0000-4000-8000-000000000000', title: 'pwned' } },
    'records:POST /v1/patients/:patientId/documents/upload-url': { patientId: encounter.patientId, body: { fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10 } },
    'records:GET /v1/patients/:patientId/timeline': { patientId: encounter.patientId },
    'patient:DELETE /v1/me/consents/:consentId': { consentId },
    'diagnostics:GET /v1/lab-orders/:id': { id: labOrderId },
    'diagnostics:POST /v1/lab-orders/:id/cancel': { id: labOrderId, body: {} },
    'diagnostics:POST /v1/lab-orders/:id/schedule': { id: labOrderId, body: { branchId: branch.id, slotAt: new Date(Date.now() + 86_400_000).toISOString() } },
    'diagnostics:PATCH /v1/admin/lab-tests/:id': { id: labTestId, body: { price: 1 } },
    'diagnostics:POST /v1/lab/lab-orders/:id/performed': { id: labOrderId },
    'diagnostics:PATCH /v1/admin/lab-packages/:id': { id: labPackageId, body: { price: 1 } },
    'diagnostics:GET /v1/lab/orders/:id/results': { id: reportOrderId },
    'diagnostics:POST /v1/lab/orders/:id/results': { id: labOrderId, body: { results: [{ itemId: labOrderId, parameter: 'Result', value: '1' }] } },
    'diagnostics:POST /v1/lab/orders/:id/verify': { id: labOrderId },
    'diagnostics:POST /v1/lab/orders/:id/amend': { id: reportOrderId, body: { reason: 'leak test amendment', results: [{ itemId: labOrderId, parameter: 'Result', value: '1' }] } },
    'diagnostics:GET /v1/lab/orders/:id/report.pdf': { id: reportOrderId },
    'diagnostics:POST /v1/lab/critical-alerts/:id/ack': { id: alertId },
    'diagnostics:GET /v1/doctor/lab-orders/:id/results': { id: reportOrderId },
    'diagnostics:POST /v1/doctor/critical-alerts/:id/ack': { id: alertId },
    'diagnostics:GET /v1/lab-orders/:id/results': { id: reportOrderId },
    'diagnostics:GET /v1/lab-orders/:id/report.pdf': { id: reportOrderId },
    'diagnostics:GET /v1/public/lab-reports/verify/:code': { code: verifyCode },
    'diagnostics:GET /v1/admin/home-windows/:branchId': { branchId: branch.id },
    'diagnostics:PUT /v1/admin/home-windows/:branchId': { branchId: branch.id, body: { windows: [{ day: 1, start: '06:00', end: '07:00' }] } },
    'diagnostics:POST /v1/lab/home-visits/:id/assign': { id: visitId, body: { phlebotomistId: phlebId } },
    'diagnostics:POST /v1/home-visits/:id/start': { id: visitId },
    'diagnostics:POST /v1/home-visits/:id/arrive': { id: visitId },
    'diagnostics:POST /v1/home-visits/:id/collect': { id: visitId, body: { barcode: 'S00000001' } },
    'diagnostics:POST /v1/home-visits/:id/miss': { id: visitId, body: { reason: 'leak test' } },
    'patient:GET /v1/me/patients/:patientId/allergies': { patientId: allergyPatient },
    'patient:POST /v1/me/patients/:patientId/allergies': { patientId: allergyPatient, body: { substance: 'pwned allergy' } },
    'patient:DELETE /v1/me/patients/:patientId/allergies/:allergyId': { patientId: allergyPatient, allergyId },
    'patient:GET /v1/patients/:patientId/allergies': { patientId: allergyPatient },
    'patient:POST /v1/patients/:patientId/allergies': { patientId: allergyPatient, body: { substance: 'pwned allergy' } },
    'billing:GET /v1/invoices/:id/pdf': { id: invoice.id },
    'billing:POST /v1/invoices/:id/refunds': { id: invoice.id, body: { amount: 1, reason: 'pwned refund' } },
    'patient:PATCH /v1/me/dependents/:id': { id: child.id, body: { fullName: 'pwned', version: 0 } },
    'notification:PUT /v1/notification-templates/:id': { id: template.id, body: { body: 'pwned template body', active: true } },
    'subscription:POST /v1/platform/plans/:code/versions': { code: 'HOSPITAL_PRO' },
    'subscription:GET /v1/platform/versions/:id': { id: planVersionId },
    'subscription:PUT /v1/platform/versions/:id': { id: planVersionId, body: { listPrice: 1, modules: ['core'] } },
    'subscription:DELETE /v1/platform/versions/:id': { id: planVersionId },
    'subscription:POST /v1/platform/versions/:id/submit': { id: planVersionId },
    'subscription:GET /v1/platform/versions/:id/impact': { id: planVersionId },
    'subscription:POST /v1/platform/versions/:id/approve': { id: planVersionId, body: {} },
    'subscription:POST /v1/platform/versions/:id/reject': { id: planVersionId, body: { note: 'pwned' } },
    'subscription:POST /v1/platform/versions/:id/retire': { id: planVersionId },
    'subscription:GET /v1/platform/hospitals/:id': { id: cityId },
    'subscription:POST /v1/platform/hospitals/:id/simulate': { id: cityId, body: { versionId: planVersionId } },
    'subscription:PUT /v1/platform/hospitals/:id/contract': { id: cityId, body: { plan: 'CLINIC_STARTER', reason: 'pwned' } },
    'subscription:PUT /v1/platform/hospitals/:id/modules/:key': { id: cityId, key: 'emr', body: { state: 'off', reason: 'pwned' } },
    'subscription:PUT /v1/platform/hospitals/:id/features/:key': { id: cityId, key: 'core.branches', body: { value: { limit: 0 }, reason: 'pwned' } },
    'subscription:GET /v1/account/invoices/:id': { id: foreignInvoice },
    // settings are keyed by name in every hospital: an unknown key (the route only ever touches the caller's hospital)
    'entitlement:PUT /v1/settings/:key': { key: 'core.leak_setting', body: { value: 1 } },
    'entitlement:PUT /v1/roles/:code': { code: 'LEAK_ROLE', body: { permissions: [] } },
    'entitlement:DELETE /v1/roles/:code': { code: 'LEAK_ROLE' },
    'entitlement:GET /v1/roles/:code/preview': { code: 'LEAK_ROLE' },
    'tenant:POST /v1/domains/:host/verify': { host: `${A}.localhost` },
    'tenant:DELETE /v1/domains/:host': { host: `${A}.localhost` },
    'subscription:GET /v1/platform/hospitals/:id/billing': { id: cityId },
    'subscription:POST /v1/platform/hospitals/:id/invoices/:invoiceId/paid': { id: cityId, invoiceId: foreignInvoice, body: { reference: 'pwned' } },
    'assistant:GET /v1/assistant/conversations/:id/messages': { id: aiConv },
    'assistant:POST /v1/assistant/conversations/:id/close': { id: aiConv },
    'assistant:POST /v1/assistant/conversations/:id/handoff': { id: aiConv, body: { reason: 'ASKED' } },
    'assistant:POST /v1/assistant/messages/:id/feedback': { id: aiMsg, body: { rating: -1 } },
    'assistant:POST /v1/assistant/handoffs/:id/close': { id: aiHandoff, body: { note: 'pwned' } },
    'assistant:PUT /v1/assistant/knowledge/:id': { id: aiArticle, body: { title: 'pwned', version: 1 } },
    'assistant:DELETE /v1/assistant/knowledge/:id': { id: aiArticle },
  };

  for (const svc of services()) {
    const route = svc.route ?? svc.schema;
    const res = await fetch(`http://localhost:${svc.port}/internal/routes`, { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } });
    if (!res.ok) { fail(`${svc.name}: cannot list routes (${res.status}) — is it running?`); continue; }
    const routes = await res.json();
    console.log(`${svc.name}: ${routes.length} routes`);
    for (const r of routes) {
      const label = `${svc.name} ${r.method} ${r.path}`;
      const gwPath = `/api/${route}${r.path}`;
      const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
      const fx = fixtures[`${route}:${r.method} ${r.path}`];

      if (r.access === 'internal') {
        const x = await call(r.method, gwPath.replace(/:(\w+)/g, '00000000-0000-0000-0000-000000000000'), {});
        x.status === 404 ? ok() : fail(`${label}: internal route reachable through gateway (${x.status})`);
        continue;
      }
      if (r.access === 'public') continue;
      if (params.length && !fx) { fail(`${label}: no leak-test fixture for path params ${params.join(', ')} — add one in platform/tests/tenancy-leak.mjs`); continue; }
      const path = gwPath.replace(/:(\w+)/g, (_, p) => encodeURIComponent(fx[p])) + (fx?.query ?? '');

      if (r.access === 'tenant-public') {
        if (r.method === 'GET') {
          const x = await call('GET', path, { host: `${B}.localhost` });
          secrets.some((s) => x.text.includes(s)) ? fail(`${label}: tenant-public route returned the other hospital's data`) : ok();
          if (params.length) [403, 404].includes(x.status) ? ok() : fail(`${label}: ${B} host with ${A} ids → ${x.status}`);
        }
        continue;
      }

      // 1. wrong hospital token, and no token
      for (const [who, t] of [['staff', tok.A], ['patient', pat.A]]) {
        const x = await call(r.method, path, { host: `${B}.localhost`, token: t, body: fx?.body });
        [401, 403].includes(x.status) ? ok() : fail(`${label}: ${A} ${who} token accepted on ${B} host (${x.status})`);
      }
      const anon = await call(r.method, path, { host: `${B}.localhost`, body: fx?.body });
      anon.status === 401 ? ok() : fail(`${label}: no token → ${anon.status}, expected 401`);

      // 2./3. the other hospital's own valid token, aimed at citycare's ids / data
      if (params.length) {
        const x = await call(r.method, path, { host: `${B}.localhost`, token: tok.B, body: fx.body });
        [403, 404].includes(x.status) ? ok() : fail(`${label}: ${B} admin using ${A} ids → ${x.status} ${x.text.slice(0, 120)}`);
      } else if (r.method === 'GET') {
        for (const t of [tok.B, pat.B]) {
          const x = await call('GET', path, { host: `${B}.localhost`, token: t });
          secrets.some((s) => x.text.includes(s)) ? fail(`${label}: ${B} response contains ${A} data`) : ok();
        }
      }
    }
  }
  // citycare's assistant knowledge article must still be there, unchanged
  psql(`SELECT title FROM assistant.kb_articles WHERE id = '${aiArticle}'`) === aiArticleTitle ? ok() : fail('citycare assistant knowledge was changed or deleted by another hospital');
  // citycare's branch must be unchanged after all of the above
  const after = (await call('GET', `/api/tenant/v1/branches/${branch.id}`, { host: `${A}.localhost`, token: tok.A })).json;
  after?.name === branch.name ? ok() : fail(`citycare branch was modified by another hospital: ${JSON.stringify(after)}`);
  const docAfter = (await call('GET', `/api/provider/v1/doctors/${doctor.id}`, { host: `${A}.localhost`, token: tok.A })).json;
  docAfter?.name === doctor.name && docAfter?.status === 'ACTIVE' ? ok() : fail(`citycare doctor was modified by another hospital: ${JSON.stringify(docAfter)?.slice(0, 200)}`);
  const schedAfter = (await call('GET', `/api/scheduling/v1/doctors/${doctor.id}/schedule`, { host: `${A}.localhost`, token: tok.A })).json;
  schedAfter?.hours?.some((h) => h.id === hours.id) && schedAfter?.leaves?.some((l) => l.id === leave.id) && !schedAfter.hours.some((h) => h.startTime === '20:00')
    ? ok() : fail('citycare schedule was modified by another hospital');
  const apptAfter = (await call('GET', `/api/scheduling/v1/appointments/${appt.id}`, PA)).json;
  apptAfter?.status === 'CONFIRMED' && apptAfter?.id === appt.id ? ok() : fail(`citycare appointment was changed by another hospital: ${JSON.stringify(apptAfter)?.slice(0, 200)}`);
  const planAfter = controlPsql(`SELECT p.code FROM subscription.contracts c JOIN subscription.plan_versions v ON v.id = c.plan_version_id JOIN subscription.plans p ON p.id = v.plan_id WHERE c.tenant_id = '${cityId}' AND c.status = 'ACTIVE'`);
  planAfter === 'HOSPITAL_ENTERPRISE' ? ok() : fail(`citycare's plan was changed through the console by another hospital: ${planAfter}`);
  const famAfter = (await call('GET', '/api/patient/v1/me/patients', PA)).json;
  famAfter?.find((p) => p.id === child.id)?.fullName === child.fullName ? ok() : fail('citycare family member was changed by another hospital');
  const waitAfter = (await call('GET', '/api/scheduling/v1/me/waitlist', PA)).json;
  waitAfter?.some((w) => w.id === wait.id) ? ok() : fail('citycare waitlist entry was removed by another hospital');
  const tplAfter = (await call('GET', '/api/notification/v1/notification-templates', { host: `${A}.localhost`, token: tok.A })).json?.find((t) => t.id === template.id);
  tplAfter?.body === template.body ? ok() : fail('citycare message template was changed by another hospital');
  const specAfter = (await call('GET', '/api/provider/v1/specialties', { host: `${A}.localhost`, token: tok.A })).json?.find((x) => x.id === spec.id);
  specAfter?.name === spec.name ? ok() : fail('citycare specialty was modified by another hospital');

  console.log(failures ? `\x1b[31m${failures} failure(s)\x1b[0m, ${checks} checks passed` : `\x1b[32mno cross-tenant leaks: ${checks} checks passed\x1b[0m`);
  process.exit(failures ? 1 : 0);
};
main().catch((e) => { console.error(e); process.exit(1); });
