#!/usr/bin/env node
// Self-serve onboarding and hospital configuration (Phase 20), against the local gateway:
//   pricing → signup (checks; nothing created before the e-mail link) → e-mail link → provisioning (each step) →
//   the owner signs in → setup guide (branding, branch, doctor, hours, bank account) → first bookings (pay at the
//   hospital, then online: paid out to the hospital less 1%) → settings within bounds (cancel cutoff applies) →
//   role editor (custom role, preview, given to a nurse, guardrails; not on Clinic Starter) → custom domain
//   (Enterprise only; verified → the domain serves the hospital) → clean-up (hospital deleted, subscription ended).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const SITE = 'medicare.localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mc = (...args) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...args], { encoding: 'utf8' });
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host) {
  const r = await fetch(G + path, { method, headers: { ...(host ? { 'x-tenant-host': host } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status, _body: j };
}
async function staffToken(email, slug) {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
const waitFor = async (fn, ms = 30000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
const tenants = () => JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' }));

const SLUG = `lotus${Date.now().toString().slice(-6)}`;
const HOST = `${SLUG}.localhost`;
const OWNER = `owner.${SLUG}@example.test`;

// ---- 1. pricing and signup checks
const plans = (await call('GET', '/api/subscription/v1/plans', null, undefined, SITE)).list;
check(plans.some((p) => p.code === 'CLINIC_PRO' && p.trialDays === 30) && !plans.some((p) => p.code === 'MEDICARE_HQ'), `pricing: ${plans.length} published plans (trials shown, internal plan hidden)`);
const avail = async (s) => (await call('GET', `/api/tenant/v1/signup/slug-available?slug=${s}`))._body;
check(!(await avail('admin')).available && !(await avail('citycare')).available && (await avail(SLUG)).available && !(await avail('Bad Name!')).available, 'web address: reserved, taken and invalid names refused; a new one is free');
const base = { hospitalName: 'Lotus Family Clinic', slug: SLUG, adminName: 'Dr Lata Lotus', adminEmail: OWNER, plan: 'CLINIC_PRO' };
check((await call('POST', '/api/tenant/v1/signup', null, { ...base, slug: 'citycare' })).code === 'SLUG_TAKEN', 'signing up for a taken address is refused');
check((await call('POST', '/api/tenant/v1/signup', null, { ...base, plan: 'MEDICARE_HQ' })).code === 'UNKNOWN_PLAN', 'internal plans cannot be signed up for');
const since = Date.now() - 1000;
const s = await call('POST', '/api/tenant/v1/signup', null, base);
check(s.http === 201 && s._body.status === 'PENDING' && !tenants().some((t) => t.slug === SLUG), 'signed up: PENDING, nothing created until the e-mail is confirmed');
check((await avail(SLUG)).available === false, 'the address is held while the link is valid');
const m = await waitFor(async () => (await mail(`to:${OWNER}`)).find((x) => Date.parse(x.Created) >= since), 20000, 500);
const text = (await (await fetch(`http://localhost:61825/api/v1/message/${m.ID}`)).json()).Text;
const token = /token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
check(!!token && /Confirm Lotus Family Clinic on MediCare/.test(m.Subject) && /30-day free trial/.test(text), `e-mail "${m?.Subject}" with a confirmation link`);
check((await call('POST', '/api/tenant/v1/signup/verify', null, { token: 'x'.repeat(32) })).http === 404, 'a wrong link is refused');

// ---- 2. provisioning
const t0 = Date.now();
await call('POST', '/api/tenant/v1/signup/verify', null, { token });
const ready = await waitFor(async () => { const r = (await call('GET', `/api/tenant/v1/signup/status?token=${token}`))._body; return r.status === 'READY' ? r : null; }, 120000, 1000);
check(!!ready && ready.steps.every((x) => x.done) && ready.steps.length === 5, `ready in ${Math.round((Date.now() - t0) / 1000)} s: ${ready?.steps.map((x) => x.key).join(', ')}`);
check(ready?.loginUrl === `http://${HOST}:3400/login?next=%2Fadmin%2Fsetup`, `sign-in link to ${ready?.url}`);
check((await call('POST', '/api/tenant/v1/signup/verify', null, { token })).http === 200 && tenants().filter((t) => t.slug === SLUG).length === 1, 'opening the link again creates nothing more');
const tid = tenants().find((t) => t.slug === SLUG).id;

// ---- 3. the owner and the setup guide
const owner = await waitFor(() => staffToken(OWNER, SLUG).catch(() => null), 30000, 1000);
let caps = await call('GET', '/api/entitlement/v1/me/capabilities', owner, undefined, HOST);
check(caps.roles?.includes('TENANT_ADMIN') && caps.billing?.status === 'TRIALING' && caps.plan?.code === 'CLINIC_PRO' && caps.nav.some((n) => n.key === 'setup-admin'), `the owner is hospital admin; Clinic Professional trial; Setup in the menu (${caps.roles} ${caps.billing?.status} ${caps.plan?.code} ${caps.nav?.map((n) => n.key).join(',')})`);
check((await call('GET', '/api/iam/v1/staff', owner, undefined, HOST)).list?.some((x) => x.email === OWNER && x.name === 'Dr Lata Lotus'), "the owner's login carries their name from signup");
let setup = (await call('GET', '/api/tenant/v1/setup', owner, undefined, HOST))._body;
check(setup.source === 'SIGNUP' && !setup.completedAt && !setup.brandingSet, 'setup guide: not started');
check((await call('GET', '/api/billing/v1/public/payment-status', null, undefined, HOST)).online === false, 'no bank account yet: patients cannot pay online');
await call('PATCH', '/api/tenant/v1/branding', owner, { name: 'Lotus Family Clinic, Pune', primaryColor: '#7c3aed', accentColor: '#f97316' }, HOST);
const brand = (await call('GET', '/api/tenant/v1/public/branding', null, undefined, HOST))._body;
check(brand.name === 'Lotus Family Clinic, Pune' && brand.branding.primaryColor === '#7c3aed', 'step 1: name and colours');
const br = await call('POST', '/api/tenant/v1/branches', owner, { name: 'Koregaon Park', city: 'Pune', address: { line1: 'Lane 5' } }, HOST);
check(br.http === 201, 'step 2: first branch');
await sleep(1500);
const specs = (await call('GET', '/api/provider/v1/specialties', owner, undefined, HOST)).list ?? [];
const doc = await call('POST', '/api/provider/v1/doctors', owner, { name: 'Dr. Meera Iyer', email: `meera.${SLUG}@example.test`, registrationNo: `MMC/${SLUG}`, specialties: [{ code: specs.find((x) => x.code === 'GENERAL_MEDICINE')?.code ?? specs[0].code, primary: true }], branches: [{ branchId: br.id, fee: 500 }], consultModes: ['IN_PERSON'] }, HOST);
const pub = await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, owner, { status: 'ACTIVE' }, HOST);
check(doc.http === 201 && pub.http < 300, 'step 3: first doctor, published');
await sleep(2000);
// the doctor reaches scheduling by event a moment after publishing (the setup guide waits the same way)
const t4 = Date.now();
let hours;
await waitFor(async () => {
  hours = await call('POST', `/api/scheduling/v1/doctors/${doc.id}/availability`, owner, { days: [1, 2, 3, 4, 5, 6, 7], branchId: br.id, startTime: '06:00', endTime: '22:00', slotMinutes: 15 }, HOST);
  return hours.http !== 404;
}, 20000, 500);
check(hours.http < 300, `step 4: opening hours (every day, so the test always finds a time; doctor known to scheduling after ${((Date.now() - t4) / 1000).toFixed(1)} s)${hours.http < 300 ? '' : `: ${hours.http} ${hours.code} ${hours.detail ?? ''}`}`);
const badPan = await call('PUT', '/api/billing/v1/payment-account', owner, { businessName: 'Lotus Family Clinic', businessType: 'proprietorship', pan: 'ABC123', accountNumber: '123456789012', ifsc: 'HDFC0001234', email: OWNER }, HOST);
check(badPan.code === 'BAD_PAN', 'an invalid PAN is refused');

// ---- 4. the first booking (pay at the hospital), before online payments are set up
const phone = `+9188${Date.now().toString().slice(-8)}`;
const since2 = Date.now() - 1000;
await call('POST', '/api/iam/v1/auth/otp/request', null, { phone }, HOST);
const code = await waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((x) => Date.parse(x.Created) >= since2 && /^\d{6} is your/.test(x.Snippet))?.Snippet.slice(0, 6), 20000, 500);
const pt = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code }, HOST)).accessToken;
const me = await call('PUT', '/api/patient/v1/me/profile', pt, { fullName: 'Ravi Patient', dob: '1980-02-02', gender: 'MALE' }, HOST);
const found = await waitFor(async () => (await call('GET', '/api/provider/v1/public/doctors?q=meera', null, undefined, HOST)).items?.[0], 20000, 1000);
const days = await waitFor(async () => { const d = (await call('GET', `/api/scheduling/v1/public/doctors/${found?.id}/slots?days=14`, null, undefined, HOST)).days; return d?.some((x) => x.slots.length) ? d : null; }, 30000, 1000);
const slots = days.flatMap((d) => d.slots);
const online = await call('POST', '/api/scheduling/v1/appointments', pt, { slotId: slots[1].slotId, patientId: me.id, paymentMode: 'ONLINE' }, HOST);
check(online.http >= 400, `paying online before a bank account is connected is refused (${online.code})`);
const first = await call('POST', '/api/scheduling/v1/appointments', pt, { slotId: slots[0].slotId, patientId: me.id }, HOST);
check(first.http === 201 && first._body.status === 'CONFIRMED', `first booking at ${SLUG}: ${first.appointmentNo} with Dr. Meera Iyer (pay at the hospital), ${Math.round((Date.now() - t0) / 1000)} s after the e-mail link`);

// ---- 5. online payments: connected, paid out less 1%
const acc = await call('PUT', '/api/billing/v1/payment-account', owner, { businessName: 'Lotus Family Clinic', businessType: 'proprietorship', pan: 'ABCDE1234F', accountNumber: '50100123456789', ifsc: 'HDFC0001234', email: OWNER }, HOST);
check(acc.connected === true && acc.account.bankLast4 === '6789' && acc.account.pan === 'ABXXXXX34F', 'step 5: bank account connected (PAN and account masked)');
check((await call('GET', '/api/billing/v1/public/payment-status', null, undefined, HOST)).online === true, 'patients can now pay online');
const paidAppt = await call('POST', '/api/scheduling/v1/appointments', pt, { slotId: slots[2].slotId, patientId: me.id, paymentMode: 'ONLINE' }, HOST);
const paid = await call('POST', '/api/billing/v1/payments/simulator/pay', pt, { orderId: paidAppt.payment?.orderId, outcome: 'success', method: 'upi' }, HOST);
const payout = await waitFor(async () => { const v = await call('GET', '/api/billing/v1/payment-account', owner, undefined, HOST); return v.transfers?.count >= 1 ? v : null; }, 20000, 700);
check(paidAppt.http === 201 && paid.http < 300 && payout?.transfers.amount === 495 && payout.transfers.platformFee === 5, `online payment of ₹500: ₹${payout?.transfers.amount} to the hospital, ₹${payout?.transfers.platformFee} MediCare fee`);
await call('POST', '/api/tenant/v1/setup/complete', owner, {}, HOST);
setup = (await call('GET', '/api/tenant/v1/setup', owner, undefined, HOST))._body;
check(!!setup.completedAt && setup.brandingSet, 'setup finished');

// ---- 6. settings within bounds
const settings = (await call('GET', '/api/entitlement/v1/settings', owner, undefined, HOST)).list ?? [];
const cut = settings.find((x) => x.key === 'appointments.cancel_cutoff_hours');
check(cut?.value === 2 && cut.min === 0 && cut.max === 72 && !settings.some((x) => x.key.startsWith('diagnostics.')), 'settings: cancel cutoff 2 h (0–72); no lab settings (no lab module)');
check((await call('PUT', '/api/entitlement/v1/settings/appointments.cancel_cutoff_hours', owner, { value: 100 }, HOST)).code === 'OUT_OF_BOUNDS', 'a value outside the range is refused');
check((await call('PUT', '/api/entitlement/v1/settings/appointments.cancel_cutoff_hours', owner, { value: 72 }, HOST)).effective === 72, 'cancel cutoff set to 72 hours');
const tooLate = await waitFor(async () => { const r = await call('POST', `/api/scheduling/v1/appointments/${first.id}/cancel`, pt, { reason: null }, HOST); return r.code === 'CANCELLATION_WINDOW_PASSED' ? r : null; }, 30000, 1000);
check(!!tooLate && /72 hours/.test(tooLate.detail ?? ''), `the patient cannot cancel online now: "${tooLate?.detail}"`);
await call('PUT', '/api/entitlement/v1/settings/appointments.cancel_cutoff_hours', owner, { value: 0 }, HOST);
const ok = await waitFor(async () => { const r = await call('POST', `/api/scheduling/v1/appointments/${first.id}/cancel`, pt, { reason: null }, HOST); return r.http === 200 ? r : null; }, 30000, 1000);
check(ok?._body.status === 'CANCELLED', 'cutoff 0: the patient cancels online');
const cityAdmin = await staffToken('admin@citycare.test', 'citycare');
check((await call('PUT', '/api/entitlement/v1/settings/diagnostics.max_advance_days', cityAdmin, { value: 120 }, 'citycare.localhost')).code === 'OUT_OF_BOUNDS', 'lab booking window beyond the product range (90 days) refused');

// ---- 7. role editor
const ed = (await call('GET', '/api/entitlement/v1/role-editor', owner, undefined, HOST))._body;
check(ed.customRoles === true && ed.catalogue.some((m) => m.module === 'appointments') && ed.roles.some((r) => r.code === 'NURSE'), `role editor: ${ed.roles?.length} roles, permissions of ${ed.catalogue?.length} modules`);
const nr = await call('POST', '/api/entitlement/v1/roles', owner, { code: 'senior_nurse', name: 'Senior nurse', description: 'Nurses who also see the day\'s appointments', copyFrom: 'NURSE' }, HOST);
check(nr.http === 201 && nr.code === 'SENIOR_NURSE' && nr.basedOn === 'NURSE' && nr.permissions.includes('appointment:checkin:branch'), 'custom role SENIOR_NURSE copied from Nurse');
const upd = await call('PUT', '/api/entitlement/v1/roles/SENIOR_NURSE', owner, { permissions: [...nr.permissions, 'appointment:read:branch', 'doctor:read:tenant'] }, HOST);
check(upd.added?.includes('appointment:read:branch'), `permissions added: see the branch's appointments (${upd.http} ${upd.code ?? ''} ${upd.detail ?? ''} ${JSON.stringify(upd.added)})`);
check((await call('PUT', '/api/entitlement/v1/roles/SENIOR_NURSE', owner, { permissions: ['lab_order:read:branch'] }, HOST)).code === 'UNKNOWN_PERMISSION', 'permissions of modules the hospital does not have are refused');
const pv = await call('GET', '/api/entitlement/v1/roles/SENIOR_NURSE/preview', owner, undefined, HOST);
check(pv.nav?.some((n) => n.zone === 'desk') && pv.home === '/desk', `preview as Senior nurse: opens ${pv.home}; menu ${pv.nav?.map((n) => n.label).join(', ')}`);
await call('POST', '/api/iam/v1/staff/invites', owner, { email: `nina.${SLUG}@example.test`, name: 'Nina Nurse', roles: ['NURSE'] }, HOST);
const nina = await waitFor(async () => (await call('GET', '/api/iam/v1/staff', owner, undefined, HOST)).list?.find((x) => x.email === `nina.${SLUG}@example.test`), 20000, 700);
await sleep(1000);
const give = await call('POST', `/api/entitlement/v1/users/${nina.userId}/roles`, owner, { roleCode: 'SENIOR_NURSE' }, HOST);
const ninaCaps = await waitFor(async () => { const c = await call('GET', '/api/entitlement/v1/me/capabilities', await staffToken(`nina.${SLUG}@example.test`, SLUG), undefined, HOST); return c.permissions?.includes('appointment:read:branch') ? c : null; }, 20000, 1000);
check(give.http < 300 && !!ninaCaps, 'Nina (nurse) gets Senior nurse: her permissions include the branch\'s appointments at once');
check((await call('DELETE', '/api/entitlement/v1/roles/SENIOR_NURSE', owner, undefined, HOST)).code === 'ROLE_IN_USE', 'a role someone holds cannot be deleted');
const ownerId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).sub;
check((await call('DELETE', `/api/entitlement/v1/users/${ownerId}/roles/TENANT_ADMIN`, owner, undefined, HOST)).code === 'OWN_ADMIN_ROLE', 'the owner cannot remove their own admin role');
check((await call('PUT', '/api/entitlement/v1/roles/TENANT_ADMIN', owner, { permissions: [] }, HOST)).code === 'ROLE_LOCKED', 'the hospital admin role cannot be edited');
check(ed.history !== undefined && (await call('GET', '/api/entitlement/v1/role-editor', owner, undefined, HOST)).history.some((h) => h.role === 'SENIOR_NURSE' && h.by === OWNER), 'role changes are recorded with who made them');
const bright = tenants().find((t) => t.slug === 'brightsmile');
if (bright) {
  const bs = await staffToken('admin@brightsmile.test', 'brightsmile');
  check((await call('POST', '/api/entitlement/v1/roles', bs, { code: 'EXTRA_ROLE', name: 'Extra', copyFrom: null }, 'brightsmile.localhost')).code === 'FEATURE_NOT_IN_PLAN', 'Clinic Starter: custom roles are not in the plan');
}

// ---- 8. custom domain (Enterprise)
const CUSTOM = `care-${SLUG}.localhost`;
check((await call('POST', '/api/tenant/v1/domains', owner, { host: CUSTOM }, HOST)).code === 'FEATURE_NOT_IN_PLAN', 'Clinic Professional: no custom domain');
mc('plan', 'set', SLUG, 'HOSPITAL_ENTERPRISE', '--reason', 'mc test onboarding: custom domain');
const addD = await waitFor(async () => { const r = await call('POST', '/api/tenant/v1/domains', owner, { host: CUSTOM }, HOST); return r.http === 201 || r.code === 'DOMAIN_EXISTS' ? r : null; }, 30000, 1000);
check(addD?.status === 'PENDING' && addD.dns?.name === `_medicare-verify.${CUSTOM}`, `Enterprise: ${CUSTOM} added, waiting for DNS (TXT ${addD?.dns?.name})`);
check((await call('GET', '/api/tenant/v1/public/branding', null, undefined, CUSTOM)).http !== 200, 'not serving the hospital before it is verified');
const ver = await call('POST', `/api/tenant/v1/domains/${CUSTOM}/verify`, owner, {}, HOST);
const viaCustom = await waitFor(async () => { const r = await call('GET', '/api/tenant/v1/public/branding', null, undefined, CUSTOM); return r.http === 200 ? r : null; }, 30000, 1000);
check(ver.status === 'ACTIVE' && viaCustom?.slug === SLUG && viaCustom.name === 'Lotus Family Clinic, Pune', `verified: ${CUSTOM} now opens ${viaCustom?.name}`);
// citycare is on Enterprise v1 (before custom domains): refused for its plan; with the feature it would be DOMAIN_EXISTS
check(['DOMAIN_EXISTS', 'FEATURE_NOT_IN_PLAN'].includes((await call('POST', '/api/tenant/v1/domains', cityAdmin, { host: CUSTOM }, 'citycare.localhost')).code), "another hospital cannot take it");

// ---- clean-up: the test hospital is deleted (kept on disk, skipped everywhere), its subscription ends
await fetch(`http://localhost:4401/internal/tenants/${tid}/status`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_API_TOKEN }, body: JSON.stringify({ status: 'DELETED' }) });
const ended = await waitFor(async () => { const r = await fetch(`http://localhost:4413/internal/tenants/${tid}/billing`, { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }); const j = await r.json(); return j.status === 'CANCELLED' ? j : null; }, 30000, 1000);
check(!!ended && !tenants().some((t) => t.slug === SLUG), 'clean-up: hospital deleted, subscription cancelled');

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32monboarding ok\x1b[0m');
process.exit(failures ? 1 : 0);
