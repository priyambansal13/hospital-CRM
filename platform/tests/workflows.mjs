#!/usr/bin/env node
// Custom fields, forms and workflow rules (Phase 27), against the local gateway, on citycare:
//   module on → admin defines patient and appointment fields (desk cannot); the desk fills them in (checked against the
//   definitions); a pre-visit form: the patient answers, the doctor and the desk see the answers; a workflow rule
//   "second no-show → tag, ask to pay online, e-mail the desk, message the patient" fires once per event; module reset.
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

const psql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
const SFX = Date.now().toString().slice(-6);

try {
  // ---- 1. module on → admin defines fields
  mc('module', 'enable', 'citycare', 'workflows');
  const admin = await staffToken('admin@citycare.test');
  const desk = await staffToken('desk@citycare.test');
  const asha = await staffToken('asha.rao@citycare.test');
  const ready = await waitFor(async () => (await call('GET', '/api/integration/v1/custom-fields', admin)).http === 200, 30000, 1000);
  check(!!ready, 'module on: the custom fields API answers');
  check((await call('POST', '/api/integration/v1/custom-fields', desk, { entity: 'PATIENT', key: 'x', label: 'x', type: 'TEXT' })).http === 403, 'the desk cannot define fields');
  const k1 = `corp_id_${SFX}`, k2 = `referral_${SFX}`;
  const f1 = await call('POST', '/api/integration/v1/custom-fields', admin, { entity: 'PATIENT', key: k1, label: 'Corporate employee ID', type: 'TEXT', required: false });
  const f2 = await call('POST', '/api/integration/v1/custom-fields', admin, { entity: 'APPOINTMENT', key: k2, label: 'Referral source', type: 'SELECT', options: ['Doctor', 'Friend', 'Camp'] });
  check(f1.http === 201 && f2.http === 201, `admin adds a patient field (${f1.key}) and an appointment choice field (${f2.key})`);
  check((await call('POST', '/api/integration/v1/custom-fields', admin, { entity: 'PATIENT', key: k1, label: 'Again', type: 'TEXT' })).code === 'KEY_TAKEN', 'a key is used once per record type');
  check((await call('PATCH', `/api/integration/v1/custom-fields/${f2.id}`, admin, { options: ['Doctor', 'Camp'], version: f2.version })).code === 'OPTION_IN_USE', 'choices cannot be removed (stored values stay valid)');

  // ---- 2. the desk fills them in
  const P = await patient(`Workflow Patient ${SFX}`);
  const pid = P.self.id;
  let pd = await call('GET', `/api/patient/v1/desk/patients/${pid}`, desk);
  check((await call('PUT', `/api/patient/v1/patients/${pid}/custom-fields`, desk, { values: { nonsense: 'x' }, version: pd.version })).http === 400, 'an unknown field is refused');
  const saved = await call('PUT', `/api/patient/v1/patients/${pid}/custom-fields`, desk, { values: { [k1]: 'EMP-4411' }, version: pd.version });
  check(saved.customFields?.[k1] === 'EMP-4411', 'the desk saves the corporate ID on the patient');
  check((await call('PUT', `/api/patient/v1/patients/${pid}/custom-fields`, desk, { values: { [k1]: 'x' }, version: pd.version })).code === 'VERSION_CONFLICT', 'a stale copy is refused');
  const mine = await call('GET', '/api/patient/v1/me/patients', P.token);
  check(!JSON.stringify(mine).includes('EMP-4411'), 'patients do not see the hospital\'s custom fields');

  // ---- 3. pre-visit form
  const formName = `Before your visit ${SFX}`;
  for (const f of (await call('GET', '/api/integration/v1/forms', admin)).list ?? []) if (f.active && !f.specialtyCode) await call('PATCH', `/api/integration/v1/forms/${f.id}`, admin, { active: false, version: f.version });
  const form = await call('POST', '/api/integration/v1/forms', admin, { name: formName, intro: 'So the doctor is ready', fields: [
    { key: 'duration', label: 'How long have you had it?', type: 'SELECT', options: ['Under a week', 'Longer'], required: true },
    { key: 'pregnant', label: 'Are you pregnant?', type: 'BOOLEAN' },
  ] });
  check(form.http === 201, 'admin adds a form for every visit');
  const doc = (await call('GET', '/api/provider/v1/public/doctors?q=asha')).items[0];
  const slot = (await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=10`)).days?.at(-1)?.slots?.at(-1);
  const appt = await call('POST', '/api/scheduling/v1/appointments', P.token, { slotId: slot.slotId, patientId: pid, paymentMode: 'AT_CLINIC' });
  check(appt.http === 201, `the patient books ${appt.appointmentNo}`);
  const fv = await call('GET', `/api/scheduling/v1/appointments/${appt.id}/form`, P.token);
  check(fv.form?.name === formName && fv.canAnswer, 'the patient gets the form for the visit');
  check((await call('PUT', `/api/scheduling/v1/appointments/${appt.id}/form`, P.token, { answers: { pregnant: 'false' } })).http === 400, 'a required answer is required');
  const ans = await call('PUT', `/api/scheduling/v1/appointments/${appt.id}/form`, P.token, { answers: { duration: 'Longer', pregnant: 'false' } });
  check(ans.answers?.answers?.duration === 'Longer', 'the patient answers');
  const seen = await call('GET', `/api/scheduling/v1/appointments/${appt.id}`, asha);
  check(seen.formAnswers?.answers?.duration === 'Longer' && seen.formAnswers.fields.length === 2, 'the doctor sees the answers with the questions');
  const ofP = await call('GET', `/api/scheduling/v1/appointments/of-patient/${pid}`, desk);
  const a1 = ofP.list?.find((a) => a.id === appt.id);
  check(!!a1?.formAnswers, 'the desk sees the visit and its answers');
  const af = await call('PUT', `/api/scheduling/v1/appointments/${appt.id}/custom-fields`, desk, { values: { [k2]: 'Camp' }, version: a1.version });
  check(af.customFields?.[k2] === 'Camp', 'the desk records the referral source on the visit');
  check(!('customFields' in (await call('GET', `/api/scheduling/v1/appointments/${appt.id}`, P.token))), 'the patient does not see visit custom fields');
  await call('POST', `/api/scheduling/v1/appointments/${appt.id}/cancel`, P.token, {});

  // ---- 4. workflow rule: the second no-show
  const cat = await call('GET', '/api/integration/v1/workflows/catalog', admin);
  check(cat.triggers?.some((t) => t.key === 'APPOINTMENT_NO_SHOW' && t.facts.some((f) => f.key === 'noShows')), `rule editor catalog: ${cat.triggers?.length} triggers`);
  check((await call('POST', '/api/integration/v1/workflows/rules', admin, { name: 'bad', trigger: 'LAB_CRITICAL_VALUE', conditions: [{ fact: 'noShows', op: 'gte', value: '2' }], actions: [{ type: 'TAG_PATIENT', tag: 'x' }] })).http === 400, 'a condition the trigger does not have is refused');
  const tag = `no-show risk ${SFX}`;
  const rule = await call('POST', '/api/integration/v1/workflows/rules', admin, {
    name: `Second no-show ${SFX}`, trigger: 'APPOINTMENT_NO_SHOW', conditions: [{ fact: 'noShows', op: 'gte', value: '2' }, { fact: 'field.' + k1, op: 'set' }],
    actions: [
      { type: 'TAG_PATIENT', tag },
      { type: 'REQUIRE_PREPAYMENT', reason: 'two missed visits' },
      { type: 'NOTIFY_STAFF', audience: 'appointment:checkin:branch', subject: `No-show ${SFX}: {{patientName}}`, message: '{{patientName}} ({{mrn}}) missed {{appointmentNo}}: {{noShows}} missed visits.' },
      { type: 'NOTIFY_PATIENT', subject: 'We missed you', message: 'We missed you at {{branchName}}. Next time please pay online when you book.' },
    ],
  });
  check(rule.http === 201, `admin adds the rule "${rule.name}"`);
  const me = await call('GET', '/api/scheduling/v1/me/doctor', asha);
  const branches = (await call('GET', '/api/diagnostics/v1/public/lab-branches')).list;
  const branchId = branches.find((b) => b.name === 'Sector 44')?.id ?? branches[0].id;
  const noShow = async () => {
    const w = await waitFor(async () => { const r = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: pid, walkIn: { doctorId: me.id, branchId } }); return r.http === 201 ? r : null; }, 15000, 1000);
    return w && call('POST', `/api/scheduling/v1/appointments/${w.id}/no-show`, desk);
  };
  const ns1 = await noShow();
  check(ns1?.status === 'NO_SHOW', 'first no-show');
  await sleep(4000);
  pd = await call('GET', `/api/patient/v1/desk/patients/${pid}`, desk);
  check(!pd.tags?.includes(tag), 'one no-show: the rule does not match');
  const ns2 = await noShow();
  check(ns2?.status === 'NO_SHOW', 'second no-show');
  const tagged = await waitFor(async () => { const p = await call('GET', `/api/patient/v1/desk/patients/${pid}`, desk); return p.tags?.includes(tag) ? p : null; }, 30000, 1000);
  check(!!tagged, `the patient is tagged "${tag}"`);
  const slot2 = (await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=10`)).days?.at(-1)?.slots?.at(-2);
  const refused = await call('POST', '/api/scheduling/v1/appointments', P.token, { slotId: slot2.slotId, patientId: pid, paymentMode: 'AT_CLINIC' });
  check(refused.code === 'PREPAYMENT_REQUIRED', `pay-at-hospital booking refused: ${refused.detail ?? refused.message}`);
  const staffMail = await waitFor(async () => (await mail(`to:desk@citycare.test subject:"No-show ${SFX}"`))[0], 30000, 1000);
  check(!!staffMail, `the front desk is e-mailed ("${staffMail?.Subject}")`);
  const patientMsg = await waitFor(async () => (await mail(`to:${P.phone.slice(1)}@sms.medicare.local "We missed you"`))[0], 30000, 1000);
  check(!!patientMsg, 'the patient gets a message');
  const runs = await call('GET', '/api/integration/v1/workflows/runs', admin);
  const mineRuns = runs.list?.filter((r) => r.ruleId === rule.id) ?? [];
  check(mineRuns.length === 1 && mineRuns[0].results.length === 4 && mineRuns[0].results.every((x) => x.ok), `the run log shows one run with 4 actions done`);
  check(psql(`SELECT no_shows FROM integration.patient_counters WHERE patient_id = '${pid}'`) === '2', 'the counter says 2 no-shows');
  await call('PATCH', `/api/integration/v1/workflows/rules/${rule.id}`, admin, { active: false, version: rule.version });
} finally {
  mc('module', 'reset', 'citycare', 'workflows');
  await sleep(2000);
  const after = await call('GET', '/api/integration/v1/custom-fields', await staffToken('admin@citycare.test'));
  check(after.http === 403 || after.http === 404, `module reset: closed (${after.http})`);
}
console.log(failures ? `\x1b[31m${failures} check(s) failed\x1b[0m` : '\x1b[32mworkflows: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
