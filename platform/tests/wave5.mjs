#!/usr/bin/env node
// Remaining gaps after wave 4 (docs/ROLE-FLOWS-AND-GAPS.md §8): amending diagnoses (E-9), owner and MediCare-staff
// notifications (4.G), overrides that end by themselves (H-7). Rate limits (B-7) are covered by unit tests and a
// manual gateway check; document purge (H-5) runs hourly.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql, db = 't_citycare') => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host = 'citycare.localhost') {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': host, 'idempotency-key': crypto.randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = r.http === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
async function staffToken(email, slug = 'citycare') {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
const waitFor = async (fn, ms = 20000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
let seq = 0;
async function patient(name) {
  const phone = `+9184${String(Date.now()).slice(-5)}${seq++ % 10}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const code = await waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6), 10000, 300);
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1975-05-05', gender: 'MALE' });
  return { token, phone, self };
}
const SFX = Date.now().toString().slice(-6);
const LETTERS = SFX.replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)]); // role codes are letters and _
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const dayPlus = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86_400_000));




const admin = await staffToken('admin@citycare.test');
const C = '/api/subscription/v1/platform';
const H = 'medicare.localhost';

// ======== E-9 amend a signed visit's diagnoses ========
const desk = await staffToken('desk@citycare.test');
const A = (await call('GET', '/api/tenant/v1/branches', admin)).list.find((b) => b.name === 'Sector 44');
const docEmail = `w5doc.${SFX}@citycare.test`;
const doc = await call('POST', '/api/provider/v1/doctors', admin, { name: `Dr. Wave Five ${SFX}`, email: docEmail, registrationNo: `W5/${SFX}`, specialties: [{ code: 'GENERAL_MEDICINE', primary: true }], branches: [{ branchId: A.id, fee: 300 }], consultModes: ['IN_PERSON'] });
await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'ACTIVE' });
const P = await patient('Wave Five Amend');
const walk = await waitFor(async () => { const r = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: P.self.id, walkIn: { doctorId: doc.id, branchId: A.id } }); return r.http === 201 && r; });
const dr = await waitFor(() => staffToken(docEmail).catch(() => null), 20000, 1000);
await call('POST', `/api/scheduling/v1/appointments/${walk.id}/start`, dr);
const enc = await waitFor(async () => { const e = await call('POST', '/api/records/v1/encounters', dr, { appointmentId: walk.id }); return e.http === 201 && e.encounter; }, 20000, 1000);
const upd = await call('PATCH', `/api/records/v1/encounters/${enc.id}`, dr, { version: enc.version, notes: 'Fever, sore throat.', diagnoses: [{ code: 'J06.9', isPrimary: true }] });
await call('POST', `/api/records/v1/encounters/${enc.id}/sign`, dr, { version: upd.version });
const am = await call('POST', `/api/records/v1/encounters/${enc.id}/amendments`, dr, { reason: 'throat swab came back positive', diagnoses: [{ code: 'J03.9', isPrimary: true }, { code: 'J06.9', isPrimary: false }] });
check(am.diagnoses?.[0]?.code === 'J03.9' && am.amendments?.at(-1)?.changed.includes('diagnoses'), 'E-9 a signed visit\'s diagnoses amended, with the reason kept');

// ======== 4.G owner notices ========
const bs = JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' })).find((t) => t.slug === 'brightsmile');
const sub = (path, b) => fetch(`http://localhost:4413/internal/tenants/${bs.id}/billing${path}`, { method: 'POST', headers: { 'x-internal-token': env.INTERNAL_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
const since = Date.now();
const mailSince = async (q) => (await mail(q)).filter((m) => Date.parse(m.Created) >= since - 2000);
await sub('/reset-trial', { days: 14 });
await sub('/advance', { to: 'trial-end' });
check(!!(await waitFor(async () => (await mailSince('to:admin@brightsmile.test subject:"Your MediCare trial has ended"')).length > 0, 30000, 1000)), '4.G the owner hears that the trial ended');
const support = await staffToken('support@medicare.test', 'medicare');
await call('POST', `${C}/hospitals/${bs.id}/reactivate`, support, { offline: true, reason: 'bank transfer received' }, H);
check(!!(await waitFor(async () => (await mailSince('to:admin@brightsmile.test subject:"Welcome back"')).length > 0, 30000, 1000)), '4.G the owner hears the subscription is active again');
check(!!(await waitFor(async () => (await mailSince('to:admin@brightsmile.test subject:"MediCare invoice"')).length > 0, 30000, 1000)), '4.G bank-transfer invoices are e-mailed');
await call('PUT', `${C}/hospitals/${bs.id}/contract`, support, { plan: 'CLINIC_PRO', reason: 'upgrade agreed by phone' }, H);
check(!!(await waitFor(async () => (await mailSince('to:admin@brightsmile.test subject:"Your MediCare plan was changed"')).length > 0, 30000, 1000)), '4.G the owner hears when MediCare changes the plan');
await call('PUT', `${C}/hospitals/${bs.id}/contract`, support, { plan: 'CLINIC_STARTER', reason: 'back after the test' }, H);
await sub('/reset-trial', { days: 14 });

// ======== 4.G MediCare staff notices ========
const pm = await staffToken('product@medicare.test', 'medicare');
const ap = await staffToken('approver@medicare.test', 'medicare');
const code = `NOTICE_${SFX}`;
const created = await call('POST', `${C}/plans`, pm, { code, name: 'Notice check', edition: 'CLINIC', tier: 'Test', copyFrom: 'CLINIC_STARTER' }, H);
await call('POST', `${C}/versions/${created.versionId}/submit`, pm, undefined, H);
check(!!(await waitFor(async () => (await mailSince(`to:approver@medicare.test subject:"Plan ${code} v1 waits for your approval"`)).length > 0, 30000, 1000)), '4.G the approver is told a plan waits for approval');
await call('POST', `${C}/versions/${created.versionId}/reject`, ap, { note: 'only a notification test' }, H);
check(!!(await waitFor(async () => (await mailSince(`to:product@medicare.test subject:"Plan ${code} v1 was sent back"`)).length > 0, 30000, 1000)), '4.G the product team hears it was sent back');
await call('DELETE', `${C}/versions/${created.versionId}`, pm, undefined, H);

// ======== H-7 overrides that end by themselves ========
const city = JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' })).find((t) => t.slug === 'citycare');
const tomorrow = dayPlus(1);
const ov = await call('PUT', `${C}/hospitals/${city.id}/features/core.branches`, support, { value: { limit: 999 }, reason: 'pilot of extra branches', until: tomorrow }, H);
check(ov.http === 200, `H-7 a feature override until ${tomorrow}`);
check((await call('PUT', `${C}/hospitals/${city.id}/features/core.branches`, support, { value: { limit: 999 }, reason: 'past date', until: '2020-01-01' }, H)).http === 400, 'H-7 an end date in the past is refused');
psql(`UPDATE subscription.contracts SET overrides = jsonb_set(overrides, '{expires,feature:core.branches}', '"2020-01-01T00:00:00.000Z"') WHERE tenant_id = '${city.id}' AND status = 'ACTIVE'`, 'mc_control');
const gone = await waitFor(async () => !(psql(`SELECT overrides->'features' ? 'core.branches' FROM subscription.contracts WHERE tenant_id = '${city.id}' AND status = 'ACTIVE'`, 'mc_control') === 't'), 40000, 2000);
check(!!gone, 'H-7 when its date passes, the override goes back to the plan by itself');

// ======== 4.G signups: the owner hears the hospital is ready, MediCare support hears about a failure ========
// (rows put straight into the table; the sweep settles them within 30 s without anyone opening the status page)
const stuck = `w5stuck${SFX}`, ready = `w5ready${SFX}`;
// a hospital whose every setup step is done: the newest one that came through a signup (the onboarding suite makes them)
const [rTenant, rEmail] = psql(`SELECT t.id || '|' || s.admin_email FROM tenant.signups s JOIN tenant.tenants t ON t.id = s.tenant_id WHERE s.status = 'READY' AND t.status = 'ACTIVE' ORDER BY s.ready_at DESC LIMIT 1`, 'mc_control').split('|');
if (!rTenant) console.log('  (no hospital from a finished signup: run the onboarding suite first)');
psql(`INSERT INTO tenant.signups (id, token_hash, slug, hospital_name, admin_name, admin_email, plan_code, status, verified_at, expires_at) VALUES
  (gen_random_uuid(), 'w5-stuck-${SFX}', '${stuck}', 'Stuck Hospital ${SFX}', 'Stuck Owner', 'stuck.${SFX}@example.test', 'CLINIC_STARTER', 'PROVISIONING', now() - interval '11 minutes', now() + interval '1 day'),
  (gen_random_uuid(), 'w5-ready-${SFX}', '${ready}', 'Ready Clinic ${SFX}', 'Ready Owner', '${rEmail}', 'CLINIC_STARTER', 'PROVISIONING', now() - interval '1 minute', now() + interval '1 day')`, 'mc_control');
psql(`UPDATE tenant.signups SET tenant_id = '${rTenant}' WHERE slug = '${ready}'`, 'mc_control');
check(!!(await waitFor(async () => (await mailSince(`to:support@medicare.test subject:"Signup failed: Stuck Hospital ${SFX}"`)).length > 0, 60000, 2000)), '4.G MediCare support is told when a signup fails');
check(psql(`SELECT status FROM tenant.signups WHERE slug = '${stuck}'`, 'mc_control') === 'FAILED', '4.G the stuck signup is marked failed');
check(!!(await waitFor(async () => (await mailSince(`to:${rEmail} subject:"Ready Clinic ${SFX} is ready on MediCare"`)).length > 0, 60000, 2000)), '4.G the owner gets a "your hospital is ready" e-mail');
check(psql(`SELECT count(*) FROM tenant.signups WHERE slug = '${ready}' AND status = 'READY'`, 'mc_control') === '1', '4.G the signup is ready without the status page open');
psql(`DELETE FROM tenant.signups WHERE slug IN ('${stuck}', '${ready}')`, 'mc_control');

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mwave 5: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
