#!/usr/bin/env node
// Wave 4 of the flow review (docs/ROLE-FLOWS-AND-GAPS.md §6): production readiness that needs no provider accounts,
// against the local gateway.
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



const TID = psql('SELECT tenant_id FROM public.tenant_meta');
const admin = await staffToken('admin@citycare.test');
const desk = await staffToken('desk@citycare.test');

// ======== B-5 payout account protection ========
// the step-up rate limit (5 codes / 10 min) would trip when this suite is run several times in a row
const redisCli = (...a) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'redis', 'redis-cli', '--no-auth-warning', '-a', env.REDIS_PASSWORD, ...a], { encoding: 'utf8' });
for (const k of redisCli('--scan', '--pattern', 'stepup-rl:*').split('\n').filter(Boolean)) redisCli('DEL', k);
const acct = { businessName: 'CityCare Clinic Pvt Ltd', businessType: 'private_limited', pan: 'ABCDE1234F', ifsc: 'HDFC0001234', email: 'accounts@citycare.test' };
let first = await call('PUT', '/api/billing/v1/payment-account', admin, { ...acct, accountNumber: '123456789012' });
if (first.code === 'STEP_UP_REQUIRED') {
  await call('POST', '/api/iam/v1/me/step-up', admin, { purpose: 'PAYOUT_ACCOUNT' });
  const m = await waitFor(async () => (await mail('to:admin@citycare.test subject:"Your confirmation code"'))[0], 20000, 1000);
  first = await call('PUT', '/api/billing/v1/payment-account', admin, { ...acct, accountNumber: '123456789012', stepUpCode: m.Subject.slice(-6) });
}
check(first.connected === true, 'payout account connected');
const noCode = await call('PUT', '/api/billing/v1/payment-account', admin, { ...acct, accountNumber: '999988887777' });
check(noCode.code === 'STEP_UP_REQUIRED', 'B-5 changing the payout account needs a confirmation code');
check((await call('POST', '/api/iam/v1/me/step-up', desk, { purpose: 'PAYOUT_ACCOUNT' })).http === 200, 'any staff member can get a code for themselves (the permission is checked on the change)');
check((await call('PUT', '/api/billing/v1/payment-account', desk, { ...acct, accountNumber: '999988887777', stepUpCode: '000000' })).http === 403, 'B-5 the desk cannot change it at all');
const before = Date.now();
await call('POST', '/api/iam/v1/me/step-up', admin, { purpose: 'PAYOUT_ACCOUNT' });
const codeMail = await waitFor(async () => (await mail('to:admin@citycare.test subject:"Your confirmation code"')).find((x) => Date.parse(x.Created) >= before - 2000), 20000, 1000);
check(!!codeMail, 'B-5 the code is e-mailed to the person (not shown in the app)');
const code = codeMail.Subject.slice(-6);
const wrong = code === '123456' ? '654321' : '123456';
check((await call('PUT', '/api/billing/v1/payment-account', admin, { ...acct, accountNumber: '999988887777', stepUpCode: wrong })).code === 'WRONG_CODE', 'B-5 a wrong code is refused');
const changed = await call('PUT', '/api/billing/v1/payment-account', admin, { ...acct, accountNumber: '999988887777', stepUpCode: code });
check(changed.account?.bankLast4 === '7777' && !!changed.holdUntil, `B-5 changed: payouts held until ${changed.holdUntil}`);
check((await call('PUT', '/api/billing/v1/payment-account', admin, { ...acct, accountNumber: '111122223333', stepUpCode: code })).code === 'STEP_UP_REQUIRED', 'B-5 a code works once');
const hist = (await call('GET', '/api/billing/v1/payment-account/history', admin)).list ?? [];
check(hist[0]?.change === 'REPLACED' && hist[0].bankLast4 === '7777' && hist[0].prevBankLast4 === '9012', 'B-5 the change is in the history (from ••9012 to ••7777)');
check(!!(await waitFor(async () => (await mail('subject:"Payout account changed: bank account ending 7777"')).length > 0, 30000, 1000)), 'B-5 the owners are told by e-mail');
// leave no hold behind for other suites (payments expects payouts to settle at once)
psql(`UPDATE billing.payment_account SET payout_hold_until = NULL`);
psql(`UPDATE billing.transfers SET status = 'SETTLED' WHERE status = 'ON_HOLD'`);

// ======== A-1 / B-6 SaaS card payments ========
check((await call('PUT', '/api/subscription/v1/account/card', admin, { number: '4111111111111111', expiry: '12/30', name: 'x' })).http === 404, 'B-6 MediCare\'s API no longer takes card numbers');
const sub = await call('GET', '/api/subscription/v1/account/subscription', admin);
check(sub.cardPayments === true, 'A-1 dev: the simulated gateway takes cards (production without keys: bank transfer only, see unit tests)');

// ======== D-7 an expired hospital comes back ========
const ptid = execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' });
const bs = JSON.parse(ptid).find((t) => t.slug === 'brightsmile');
if (!bs) console.log('  (D-7: hospital brightsmile not found; run mc test billing once)');
else {
  const sub = (path, body) => fetch(`http://localhost:4413/internal/tenants/${bs.id}/billing${path}`, { method: 'POST', headers: { 'x-internal-token': env.INTERNAL_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
  await sub('/reset-trial', { days: 14 });
  await sub('/advance', { to: 'trial-end' });
  const owner = await staffToken('admin@brightsmile.test', 'brightsmile');
  const S = (m, path, b) => call(m, `/api/subscription/v1/account${path}`, owner, b, 'brightsmile.localhost');
  check((await S('GET', '/subscription')).status === 'EXPIRED', 'trial ended without a card: EXPIRED (read-only)');
  check((await S('POST', '/reactivate', {})).code === 'NO_CARD', 'D-7 resubscribing needs a card first');
  const st = await S('POST', '/card-session', { returnUrl: 'http://brightsmile.localhost:3400/account/card/return' });
  await call('POST', `/api/subscription/v1/sim-gateway/mandate/${st.sessionId}`, null, { number: '4111 1111 1111 1111', expiry: '12/30', name: 'Dr Smile' }, 'brightsmile.localhost');
  await S('POST', `/card-session/${st.sessionId}/complete`, {});
  const back = await S('POST', '/reactivate', {});
  check(back.status === 'ACTIVE' && back.invoice?.paid === true, `D-7 resubscribed: ACTIVE, invoice ${back.invoice?.number} paid`);
  const caps = await waitFor(async () => { const c = await call('GET', '/api/entitlement/v1/me/capabilities', owner, undefined, 'brightsmile.localhost'); return c.billing?.status === 'ACTIVE' && c.readOnlyModules?.length === 0 && c; }, 30000, 1000);
  check(!!caps, 'D-7 every module is in full use again');
  check((await S('POST', '/reactivate', {})).code === 'NOT_ENDED', 'D-7 nothing to reactivate when active');
  // support: by bank transfer
  await sub('/reset-trial', { days: 14 });
  await sub('/advance', { to: 'trial-end' });
  const support = await staffToken('support@medicare.test', 'medicare');
  const sup = await call('POST', `/api/subscription/v1/platform/hospitals/${bs.id}/reactivate`, support, { offline: true, reason: 'paid by bank transfer, ticket 42' }, 'medicare.localhost');
  check(sup.status === 'ACTIVE' && sup.invoice?.paid === false, 'D-7 support reactivated it on bank transfer: the invoice waits for the payment');
  await sub('/reset-trial', { days: 14 });
}

// ======== A-2 SMS with DLT templates ========
const tpls = (await call('GET', '/api/notification/v1/notification-templates', admin)).list ?? [];
const sms = tpls.find((t) => t.key === 'appointment_confirmed' && t.channel === 'SMS' && t.language === 'en');
const saved = await call('PUT', `/api/notification/v1/notification-templates/${sms.id}`, admin, { body: sms.body, active: true, providerTemplateId: 'msg91_flow_test', dltTemplateId: '1107161234567890123' });
check(saved.providerTemplateId === 'msg91_flow_test' && saved.dltTemplateId === '1107161234567890123', 'A-2 an SMS template carries its DLT and provider template ids');
check((await call('PUT', `/api/notification/v1/notification-templates/${sms.id}`, admin, { body: sms.body, active: true, dltTemplateId: 'abc' })).http === 400, 'A-2 DLT template ids are digits');
await call('PUT', `/api/notification/v1/notification-templates/${sms.id}`, admin, { body: sms.body, active: true, providerTemplateId: null, dltTemplateId: null });

// ======== H-3 health and metrics ========
const live = await fetch('http://localhost:4405/health/live').then((r) => r.status);
const ready = await fetch('http://localhost:4405/health/ready').then((r) => r.json());
check(live === 200 && ready.status === 'up' && Object.values(ready.checks).every((v) => v === 'up') && 'redis' in ready.checks, `H-3 liveness and readiness (${Object.keys(ready.checks).join(', ')}) are separate probes`);
await call('GET', `/api/scheduling/v1/appointments/${crypto.randomUUID()}`, admin);
const prom = await fetch('http://localhost:9405/metrics').then((r) => r.text());
check(/mc_http_request_duration_seconds_count\{method="GET",route="\/v1\/appointments\/:id",status="404"\}/.test(prom) && !/route="\/v1\/appointments\/[0-9a-f]{8}-/.test(prom), 'H-3 request metrics by route template (no ids or patient data in labels)');
check(/mc_outbox_pending \d+/.test(prom) && prom.includes('mc_dlq_messages_total'), 'H-3/H-4 outbox backlog and dead-letter counters are exported');
check((await fetch('http://localhost:61000/api/scheduling/metrics', { headers: { 'x-tenant-host': 'citycare.localhost' } })).status === 404, 'H-3 metrics are not reachable through the API gateway');

// ======== H-7 console support actions ========
if (bs) {
  const sub = (path, body) => fetch(`http://localhost:4413/internal/tenants/${bs.id}/billing${path}`, { method: 'POST', headers: { 'x-internal-token': env.INTERNAL_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
  const support = await staffToken('support@medicare.test', 'medicare');
  const C = (m, path, b) => call(m, `/api/subscription/v1/platform/hospitals/${bs.id}${path}`, support, b, 'medicare.localhost');
  await sub('/reset-trial', { days: 14 });
  const ext = await C('POST', '/trial', { days: 10, reason: 'pilot needs more time' });
  check(!!ext.trialEndsAt && Date.parse(ext.trialEndsAt) > Date.now() + 23 * 86_400_000, 'H-7 support extended the trial by 10 days');
  check((await C('POST', '/trial', { days: 60, reason: 'way too long' })).code === 'TRIAL_TOO_LONG', 'H-7 a trial can end at most 60 days from today');
  const cr = await C('POST', '/credits', { amount: 500, reason: 'outage on 30 October' });
  check(cr.openCredit === 500, 'H-7 credit note of ₹500 recorded');
  const owner = await staffToken('admin@brightsmile.test', 'brightsmile');
  const st = await call('POST', '/api/subscription/v1/account/card-session', owner, { returnUrl: 'http://brightsmile.localhost:3400/account/card/return' }, 'brightsmile.localhost');
  await call('POST', `/api/subscription/v1/sim-gateway/mandate/${st.sessionId}`, null, { number: '4111 1111 1111 1111', expiry: '12/30', name: 'Dr Smile' }, 'brightsmile.localhost');
  await call('POST', `/api/subscription/v1/account/card-session/${st.sessionId}/complete`, owner, {}, 'brightsmile.localhost');
  await sub('/advance', { to: 'trial-end' });
  const invs = (await call('GET', '/api/subscription/v1/account/invoices', owner, undefined, 'brightsmile.localhost')).list ?? [];
  const first = await call('GET', `/api/subscription/v1/account/invoices/${invs[0]?.id}`, owner, undefined, 'brightsmile.localhost');
  check((first.lines ?? []).some((l) => l.kind === 'CREDIT' && l.amount === -500 && /outage/.test(l.description)), 'H-7 the credit comes off the first invoice');
  await sub('/reset-trial', { days: 14 });
  // take a hospital offline and back; delete needs the slug
  const tmp = `wfour${SFX}`;
  execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), 'tenant', 'create', tmp, '--name', `W4 ${SFX}`, '--plan', 'CLINIC_STARTER'], { stdio: 'ignore' });
  const tid = JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' })).find((t) => t.slug === tmp).id;
  const S = (b) => call('POST', `/api/subscription/v1/platform/hospitals/${tid}/status`, support, b, 'medicare.localhost');
  check((await S({ status: 'SUSPENDED', reason: 'legal hold requested' })).status === 'SUSPENDED', 'H-7 support took the hospital offline');
  check((await call('GET', '/api/tenant/v1/public/branding', null, undefined, `${tmp}.localhost`)).http >= 400, 'H-7 an offline hospital does not answer');
  check((await S({ status: 'ACTIVE', reason: 'legal hold lifted' })).status === 'ACTIVE', 'H-7 and brought it back');
  check((await S({ status: 'DELETED', reason: 'customer left', confirmSlug: 'wrong' })).code === 'CONFIRM_SLUG', 'H-7 deleting needs the slug typed again');
  check((await S({ status: 'DELETED', reason: 'test hospital, not needed', confirmSlug: tmp })).status === 'DELETED', 'H-7 deleted (data kept for the retention period)');
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mwave 4: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
