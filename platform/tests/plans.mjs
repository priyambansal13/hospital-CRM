#!/usr/bin/env node
// Plans, editions and module lifecycle (Phase 17), against the local gateway, with a hospital of its own (greenleaf):
//   Clinic Starter (no lab: lab APIs refused, no catalog) → upsell → Hospital Professional (lab switched on: catalog
//   seeded, a patient books a test) → back to Clinic Starter (lab READ-ONLY: the patient still sees the order, nothing
//   new can be booked or edited, signed-out catalogue gone) → limits (branches) and a quota add-on → module overrides
//   and dependency checks → upgrade again (same data, booking works).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const SUB = 'http://localhost:4413';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const SLUG = 'greenleaf';
const HOST = `${SLUG}.localhost`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', `t_${SLUG}`, '-c', sql], { encoding: 'utf8' }).trim();
const mc = (...args) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...args], { encoding: 'utf8' });
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host = HOST, extra = {}) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': host, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...j, status: r.status, _body: j };
}
const internal = async (method, path, body) => {
  const r = await fetch(SUB + path, { method, headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_API_TOKEN }, body: body ? JSON.stringify(body) : undefined });
  return { ...(await r.json().catch(() => ({}))), status: r.status };
};
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });
async function staffToken(email, slug = SLUG) {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
const waitFor = async (fn, ms = 30000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
const caps = (token) => call('GET', '/api/entitlement/v1/me/capabilities', token);
const plan = (code, extra = []) => mc('plan', 'set', SLUG, code, '--reason', 'mc test plans', ...extra);
const ist = (offsetDays) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offsetDays * 86_400_000));

// ---- 0. catalogue
const pub = await call('GET', '/api/subscription/v1/plans', null, undefined, 'citycare.localhost');
check(pub.status === 200 && ['CLINIC_STARTER', 'HOSPITAL_PRO', 'DIAGNOSTIC_PRO'].every((c) => pub._body.some((p) => p.code === c)), `published plans: ${pub._body.map?.((p) => p.code).join(', ')}`);
check((await call('GET', '/api/subscription/internal/plans', null, undefined, 'citycare.localhost')).status === 404, 'plan/contract admin API is not reachable through the gateway');

// ---- 1. a new clinic on Clinic Starter
const exists = JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' })).find((t) => t.slug === SLUG);
if (!exists) {
  mc('tenant', 'create', SLUG, '--name', 'Greenleaf Clinic', '--admin', `admin@${SLUG}.test`, '--plan', 'CLINIC_STARTER');
  console.log(`  (created hospital ${SLUG})`);
}
const tenantId = exists?.id ?? JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' })).find((t) => t.slug === SLUG).id;
await waitFor(async () => (await internal('GET', `/internal/tenants/${tenantId}/contract`)).status === 200);
plan('CLINIC_STARTER');
if (!exists) check(psql('SELECT count(*) FROM diagnostics.lab_tests') === '0', 'a new clinic without the lab has no lab catalog (nothing seeded at signup)');
const admin = await waitFor(() => staffToken(`admin@${SLUG}.test`).catch(() => null), 30000, 1000);
let c = await caps(admin);
// first run: never had the lab (no lab menu at all); later runs: the lab from the previous run is read-only
check(c.plan?.code === 'CLINIC_STARTER' && !c.modules.includes('diagnostics') && (exists ? c.readOnlyModules.includes('diagnostics') : !c.nav.some((n) => n.zone === 'lab')), `Clinic Starter: modules ${c.modules.join(', ')}; lab ${exists ? 'read-only from the last run' : 'not in the menu'}`);
check(c.features['core.branches']?.limit === 1 && c.features['core.custom_roles']?.enabled === false, 'Clinic Starter: 1 branch, no custom roles');
const myPlan = await call('GET', '/api/subscription/v1/plan', admin);
check(myPlan.status === 200 && myPlan.plan.name === 'Clinic Starter' && myPlan.features.some((f) => f.key === 'directory.doctors' && f.limit === 10), 'admin sees the plan, its modules and limits (doctors 10)');
const offCatalog = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
check(offCatalog.status === 403 && offCatalog.code === 'MODULE_NOT_IN_PLAN', `signed-out lab catalog refused: ${offCatalog.status} ${offCatalog.code}`);
const ups = await call('GET', '/api/subscription/v1/upsell?module=diagnostics', admin);
check(ups.status === 200 && ups.options[0]?.code === 'HOSPITAL_PRO' && !ups.options.some((o) => o.code.startsWith('DIAGNOSTIC')), `upsell for the lab: ${ups.options?.map((o) => `${o.kind} ${o.code} ₹${o.monthlyTotal}`).join(' | ')} (no plan that would drop the clinic modules)`);

// a branch (the plan allows one)
let branches = (await call('GET', '/api/tenant/v1/branches', admin))._body;
if (!branches.some((b) => b.name === 'Greenleaf Main')) {
  const b = await call('POST', '/api/tenant/v1/branches', admin, { name: 'Greenleaf Main', city: 'Gurugram', address: { line1: 'Sector 29' } }, HOST, idem());
  check(b.status === 200 || b.status === 201, 'first branch created');
  branches = (await call('GET', '/api/tenant/v1/branches', admin))._body;
}
const second = await call('POST', '/api/tenant/v1/branches', admin, { name: 'Greenleaf East', city: 'Gurugram', address: { line1: 'Sector 56' } }, HOST, idem());
check(branches.filter((b) => b.active).length >= 1 && (second.code === 'PLAN_LIMIT_REACHED' || branches.some((b) => b.name === 'Greenleaf East')), `second branch on Clinic Starter → ${second.status} ${second.code ?? ''}`);
const more = await call('GET', '/api/subscription/v1/upsell?feature=core.branches', admin);
check(more.options?.[0]?.code === 'BRANCHES_5', `upsell for more branches: ${more.options?.map((o) => o.code).join(', ')}`);

// ---- 2. upgrade: the lab is switched on and seeded
plan('HOSPITAL_PRO');
c = await caps(admin);
check(c.plan?.code === 'HOSPITAL_PRO' && c.modules.includes('diagnostics') && c.modules.includes('home_collection') && c.nav.some((n) => n.zone === 'lab'), 'Hospital Professional: diagnostics + home collection active, lab in the menu');
check(Number(psql('SELECT count(*) FROM diagnostics.lab_tests')) > 20 && Number(psql('SELECT count(*) FROM diagnostics.lab_packages')) > 0, `the enable hook seeded the lab catalog (${psql('SELECT count(*) FROM diagnostics.lab_tests')} tests)`);
const main = branches.find((b) => b.name === 'Greenleaf Main');
const labBranch = await waitFor(async () => (await call('GET', '/api/diagnostics/v1/public/lab-branches'))._body.find?.((b) => b.id === main.id));
check(!!labBranch, 'collection times exist for the branch (lab branches lists it)');
const cat = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
const CBC = cat.tests?.find((t) => t.code === 'CBC');

// a patient books a blood test
const phone = `+9184${String(Date.now()).slice(-8)}`;
const since = Date.now() - 1000;
await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
const code = await waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => Date.parse(m.Created) >= since && /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6), 20000, 300);
const P = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
const self = await call('PUT', '/api/patient/v1/me/profile', P, { fullName: 'Gita Green', dob: '1985-05-05', gender: 'FEMALE' });
let slot;
for (let d = 1; d < 8 && !slot; d++) slot = (await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${main.id}&date=${ist(d)}`)).slots?.find((s) => s.left > 0);
const order = await call('POST', '/api/diagnostics/v1/lab-orders', P, { patientId: self.id, branchId: main.id, slotAt: slot.slotAt, items: [{ testId: CBC.id }], paymentMode: 'AT_CLINIC' }, HOST, idem());
check(order.status < 300 && order._body.status === 'BOOKED', `patient booked ${order.orderNo} (CBC) at Greenleaf Main`);

// ---- 3. downgrade: lab read-only, data intact
plan('CLINIC_STARTER');
c = await caps(admin);
check(c.readOnlyModules?.includes('diagnostics') && !c.modules.includes('diagnostics'), `back on Clinic Starter: diagnostics read-only (${c.readOnlyModules?.join(', ')})`);
check(c.permissions.includes('lab_order:read:branch') && !c.permissions.includes('sample:collect:branch') && !c.permissions.includes('lab_catalog:manage:tenant'), 'staff keep "read" lab permissions only (no collecting, no catalog edits)');
check(c.nav.some((n) => n.key === 'lab-worklist') && !c.nav.some((n) => n.key === 'lab-catalog-admin'), 'menu: lab worklist (to look up) stays, lab catalog admin is gone');
const pc = await caps(P);
check(pc.nav.some((n) => n.key === 'my-lab-orders') && !pc.nav.some((n) => n.key === 'book-tests'), 'patient menu: "My lab tests" stays, "Lab tests" (booking) is gone');
const mine = await call('GET', '/api/diagnostics/v1/me/lab-orders', P);
const kept = (mine._body.items ?? mine._body).find?.((o) => o.id === order.id);
check(mine.status === 200 && kept?.status === 'BOOKED', `patient still sees ${order.orderNo} (${kept?.status})`);
const wl = await call('GET', `/api/diagnostics/v1/lab/worklist?branchId=${main.id}&date=${order.localDate}`, admin);
check(wl.status === 200 && wl.orders.some((o) => o.id === order.id), 'staff can still open the worklist with the order');
// other services learn of the change by event (their cached entitlements are invalidated): wait for it with a
// harmless read before trying to book
await waitFor(async () => (await call('GET', '/api/diagnostics/v1/public/lab-catalog')).status === 403, 40000, 1000);
const again = await call('POST', '/api/diagnostics/v1/lab-orders', P, { patientId: self.id, branchId: main.id, slotAt: slot.slotAt, items: [{ testId: CBC.id }], paymentMode: 'AT_CLINIC' }, HOST, idem());
check(again.status === 403 && again.code === 'MODULE_READ_ONLY', `new booking refused: ${again.status} ${again.code}`);
const edit = await call('PATCH', `/api/diagnostics/v1/admin/lab-tests/${CBC.id}`, admin, { price: 999 });
check(edit.status === 403 && ['MODULE_READ_ONLY', 'PERMISSION_DENIED'].includes(edit.code), `catalog edit refused: ${edit.status} ${edit.code}`);
check((await call('GET', '/api/diagnostics/v1/public/lab-catalog')).status === 403, 'signed-out catalogue: gone (nothing to book)');
check(psql(`SELECT status FROM diagnostics.lab_orders WHERE id = '${order.id}'`) === 'BOOKED' && Number(psql('SELECT count(*) FROM diagnostics.lab_tests')) > 20, 'data intact in the hospital database');
const pm = await call('GET', '/api/entitlement/v1/public/modules');
check(pm.readOnly?.includes('diagnostics') && !pm.modules.includes('diagnostics'), 'public module list: diagnostics read-only');

// ---- 4. limits and a quota add-on
const two = await call('POST', '/api/tenant/v1/branches', admin, { name: 'Greenleaf East', city: 'Gurugram', address: { line1: 'Sector 56' } }, HOST, idem());
const hasEast = (await call('GET', '/api/tenant/v1/branches', admin))._body.some((b) => b.name === 'Greenleaf East');
check(hasEast ? two.status === 409 || two.code === 'PLAN_LIMIT_REACHED' : two.status === 422 && two.code === 'PLAN_LIMIT_REACHED' && two.limit === 1, `Clinic Starter: a second branch → ${two.status} ${two.code}`);
plan('CLINIC_STARTER', ['--addons', 'BRANCHES_5']);
c = await caps(admin);
// services cache capabilities until entitlement-service's change event evicts them (a moment after the switch)
const east = await waitFor(async () => { const r = await call('POST', '/api/tenant/v1/branches', admin, { name: 'Greenleaf East', city: 'Gurugram', address: { line1: 'Sector 56' } }, HOST, idem()); return r.code === 'PLAN_LIMIT_REACHED' ? null : r; }, 40000, 1000) ?? {};
check(c.features['core.branches'].limit === 6 && (east.status === 200 || east.status === 201 || east.code === 'BRANCH_EXISTS'), `+5 branches add-on: limit 6, second branch ${east.status === 409 ? 'already there' : 'created'}`);
const notAllowed = await internal('PUT', `/internal/tenants/${tenantId}/contract`, { plan: 'CLINIC_STARTER', addons: [{ code: 'LAB' }], by: 'test', reason: 'lab add-on on starter' });
check(notAllowed.status === 422 && notAllowed.code === 'ADDON_NOT_ALLOWED', 'the lab add-on is not sold with Clinic Starter');

// ---- 5. overrides and dependencies
mc('module', 'enable', SLUG, 'diagnostics');
c = await caps(admin);
check(c.modules.includes('diagnostics'), 'support switches the lab on for this hospital only (override): active again');
const dep = await internal('PUT', `/internal/tenants/${tenantId}/overrides/modules/directory`, { state: 'off', by: 'test' });
check(dep.status === 422 && dep.code === 'MODULE_DEPENDENCY', `switching off directory refused: ${dep.detail ?? dep.message}`);
const core = await internal('PUT', `/internal/tenants/${tenantId}/overrides/modules/core`, { state: 'off', by: 'test' });
check(core.status === 422 && core.code === 'MODULE_ALWAYS_ON', 'core cannot be switched off');
mc('module', 'reset', SLUG, 'diagnostics');
c = await caps(admin);
check(c.readOnlyModules.includes('diagnostics'), 'override removed: back to read-only');

// ---- 6. upgrade again: same data, booking works
plan('HOSPITAL_PRO');
const back = await call('GET', '/api/diagnostics/v1/me/lab-orders', P);
const ok = await call('POST', '/api/diagnostics/v1/lab-orders/' + order.id + '/cancel', P, { reason: 'test done' });
check((back._body.items ?? back._body).some?.((o) => o.id === order.id) && ok.status === 200 && ok._body.status === 'CANCELLED', `upgraded again: ${order.orderNo} is still there and can be changed (cancelled)`);
const hist = await internal('GET', `/internal/tenants/${tenantId}/contract`);
check(hist.history.length >= 5 && hist.history.filter((h) => h.status === 'ACTIVE').length === 1, `contract history kept (${hist.history.length} entries, one active)`);

// ---- 7. the demo hospitals' plans are untouched
const city = await call('GET', '/api/subscription/v1/plan', await staffToken('admin@citycare.test', 'citycare'), undefined, 'citycare.localhost');
check(city.plan?.code === 'HOSPITAL_ENTERPRISE', `citycare stays on ${city.plan?.name}`);

plan('CLINIC_STARTER');
console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mplans ok\x1b[0m');
process.exit(failures ? 1 : 0);
