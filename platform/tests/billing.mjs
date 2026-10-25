#!/usr/bin/env node
// SaaS billing and usage metering (Phase 19), against the local gateway, on its own hospital (brightsmile) with the
// dev billing clock: trial + card + coupon → converts to paid (prorated) → SMS beyond the allowance → the renewal
// is declined → past due → 3 retries → grace → suspended (read-only, records viewable) → pays → active → upgrade
// (prorated, now) and downgrade (at the period end) → cancel; e-mails to the account owner; offline (bank) payment.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const SUB = 'http://localhost:4413';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const SLUG = 'brightsmile';
const HOST = `${SLUG}.localhost`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mc = (...args) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...args], { encoding: 'utf8' });
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host = HOST) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': host, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), status: r.status, _body: j };
}
const internal = async (method, path, body) => {
  if (method === 'GET') { const r = await fetch(SUB + path, { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }); return { ...(await r.json().catch(() => ({}))), http: r.status }; }
  const r = await fetch(SUB + path, { method, headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_API_TOKEN }, body: JSON.stringify(body ?? {}) });
  return { ...(await r.json().catch(() => ({}))), http: r.status };
};
async function staffToken(email, slug = SLUG) {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
const waitFor = async (fn, ms = 30000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
const inbox = (subject, since) => waitFor(async () => (await mail(`to:admin@${SLUG}.test subject:"${subject}"`)).find((m) => Date.parse(m.Created) >= since), 90000, 1000);
const caps = (t) => call('GET', '/api/entitlement/v1/me/capabilities', t);
const capsUntil = (t, pred) => waitFor(async () => { const c = await caps(t); return pred(c) ? c : null; }, 30000, 700);

// ---- setup: brightsmile on Clinic Starter, a fresh 14-day trial
const tenants = JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' }));
if (!tenants.some((t) => t.slug === SLUG)) { mc('tenant', 'create', SLUG, '--name', 'Bright Smile Dental', '--admin', `admin@${SLUG}.test`, '--plan', 'CLINIC_STARTER'); console.log(`  (created hospital ${SLUG})`); }
const tid = JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' })).find((t) => t.slug === SLUG).id;
await waitFor(async () => (await internal('GET', `/internal/tenants/${tid}/billing`)).http === 200, 60000, 1000);
mc('plan', 'set', SLUG, 'CLINIC_STARTER', '--reason', 'mc test billing');
let admin = await waitFor(() => staffToken(`admin@${SLUG}.test`).catch(() => null), 60000, 2000);
let hq = await staffToken('support@medicare.test', 'medicare').catch(() => null);
// access tokens last 5 minutes and this test runs longer: sections log in again
const relogin = async () => { admin = await staffToken(`admin@${SLUG}.test`); hq = await staffToken('support@medicare.test', 'medicare'); };
await call('PUT', `/api/subscription/v1/platform/hospitals/${tid}/features/core.sms`, hq, { value: null, reason: 'test reset' }, 'medicare.localhost');
const start = Date.now();
const reset = await internal('POST', `/internal/tenants/${tid}/billing/reset-trial`, { days: 14 });
// earlier runs left paid invoices: look only at this run's
const old = new Set(((await internal('GET', `/internal/tenants/${tid}/billing`)).invoices ?? []).map((i) => i.id));
const fresh = (b) => (b.invoices ?? []).filter((i) => !old.has(i.id));
check(reset.http === 200 && reset.status === 'TRIALING' && reset.plan?.code === 'CLINIC_STARTER', 'brightsmile: Clinic Starter, fresh 14-day trial');

// ---- 1. the trial
let c = await capsUntil(admin, (x) => x.billing?.status === 'TRIALING');
check(!!c && c.nav.some((n) => n.zone === 'account'), 'capabilities: subscription TRIALING; the account zone is in the owner\'s menu');
const s0 = await call('GET', '/api/subscription/v1/account/subscription', admin);
check(s0.status === 200 && s0._body.status === 'TRIALING' && !s0.paymentMethod && s0.estimate.total === 5898.82, `account: trial until ${s0.trialEndsAt?.slice(0, 10)}, a month = ₹4,999 + GST 18% = ₹${s0.estimate?.total}`);
const cmp = await call('GET', '/api/subscription/v1/account/plans', admin);
check(cmp.plans?.some((p) => p.code === 'CLINIC_PRO' && p.monthly >= 9999) && !cmp.plans.some((p) => p.code === 'MEDICARE_HQ'), `plan picker priced for this hospital (${cmp.quantities?.doctor} doctors, ${cmp.quantities?.branch} branch)`);
check((await call('GET', '/api/subscription/v1/account/subscription', await staffToken('admin@citycare.test', 'citycare'), undefined, 'citycare.localhost'))._body.status === 'ACTIVE', 'another hospital sees only its own subscription');
check((await call('PUT', '/api/subscription/v1/account/card', admin, { number: '4111 1111 1111 1112', expiry: '12/30', name: 'Dr Smile' })).code === 'CARD_REFUSED', 'an invalid card number is refused');
const card = await call('PUT', '/api/subscription/v1/account/card', admin, { number: '4111 1111 1111 1111', expiry: '12/30', name: 'Dr Smile' });
check(card.status === 200 && card.last4 === '1111' && card.brand === 'Visa', 'card saved for renewals (only the last 4 digits kept)');
const cp = await call('POST', '/api/subscription/v1/account/coupon', admin, { code: 'welcome20' });
check(cp.code === 'WELCOME20' && cp.invoices === 3, 'coupon WELCOME20: 20% off 3 invoices');
check((await call('POST', '/api/subscription/v1/account/coupon', admin, { code: 'LAUNCH1000' })).code === 'COUPON_EXISTS', 'one coupon at a time');

// ---- 2. trial ends → paid
const b = await internal('POST', `/internal/tenants/${tid}/billing/advance`, { to: 'trial-end' });
check(b.http === 200 && b.status === 'ACTIVE', `billing clock moved to the end of the trial (${b.clockOffsetDays} days ahead): ${b.status}`);
let bill = await internal('GET', `/internal/tenants/${tid}/billing`);
const first = fresh(bill).find((i) => i.kind === 'FIRST');
const firstDetail = await call('GET', `/api/subscription/v1/account/invoices/${first?.id}`, admin);
check(bill.http === 200 && first?.status === 'PAID' && firstDetail.discountLabel?.startsWith('WELCOME20') && firstDetail.lines.some((l) => /Clinic Starter \(/.test(l.description)) && firstDetail.gstPercent === 18,
  `trial → ACTIVE: first invoice ${first?.number} for ${first?.periodStart?.slice(0, 10)} → ${first?.periodEnd?.slice(0, 10)} (prorated), 20% off, GST: ₹${first?.total} paid`);
c = await capsUntil(admin, (x) => x.billing?.status === 'ACTIVE');
check(!!c, 'capabilities: ACTIVE');
check(!!(await inbox('Your MediCare subscription has started', start)), 'e-mail to the account owner: subscription started');

await relogin();
// ---- 3. SMS beyond the allowance (support sets the allowance to 5 for the test; login codes count, never blocked)
const ov = await call('PUT', `/api/subscription/v1/platform/hospitals/${tid}/features/core.sms`, hq, { value: { limit: 5 }, reason: 'billing test: small SMS allowance' }, 'medicare.localhost');
check(ov.effective?.features['core.sms']?.limit === 5 && ov.effective.features['core.sms'].overage === 'ALLOW_BILL', 'SMS allowance 5 this month, extra billed (ALLOW_BILL)');
const before = (await call('GET', '/api/subscription/v1/account/usage', admin)).list?.find((m) => m.key === 'core.sms')?.used ?? 0;
const phones = Array.from({ length: 8 }, (_, i) => `+9186${String(Date.now()).slice(-7)}${i}`);
let otps = 0;
for (const phone of phones) if ((await call('POST', '/api/iam/v1/auth/otp/request', null, { phone })).status < 300) otps++;
// the first one signs in: a patient of brightsmile (to show records stay readable when suspended)
const code = await waitFor(async () => (await mail(`to:${phones[0].slice(1)}@sms.medicare.local`)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6), 20000, 500);
const patient = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone: phones[0], code })).accessToken;
const me = await call('PUT', '/api/patient/v1/me/profile', patient, { fullName: 'Sana Smile', dob: '1990-01-01', gender: 'FEMALE' });
const usage = await waitFor(async () => { const m = (await call('GET', '/api/subscription/v1/account/usage', admin)).list?.find((x) => x.key === 'core.sms'); return m && m.used >= before + 8 ? m : null; }, 20000, 500);
check(otps === 8 && !!usage && usage.limit === 5 && usage.percent >= 160, `8 login codes sent (never blocked): ${usage?.used} of ${usage?.limit} SMS (${usage?.percent}%)`);
await internal('POST', '/internal/usage/flush');
// once per hospital per month (notification dedupe), so an earlier run this month may have sent them
const monthStart = Date.parse(`${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`);
// (Mailpit keeps only its newest ~500 messages: an alert sent by an earlier run can be gone from it, so the
// hospital's notification log is the record that it was sent)
const sentThisMonth = (pct) => execFileSync('docker', ['exec', 'medicare-postgres-1', 'psql', '-U', 'postgres', '-d', `t_${SLUG}`, '-tAc',
  `SELECT count(*) FROM notification.notifications WHERE dedupe_key LIKE '%:usage:core.sms:%:${pct}:%' AND status = 'SENT' AND created_at >= date_trunc('month', now())`], { encoding: 'utf8' }).trim() !== '0';
const alerted = async (subject, pct) => sentThisMonth(pct) || !!(await inbox(subject, monthStart));
check(await alerted("This month's SMS messages allowance is used up", 100) && await alerted("80% of this month's SMS messages used", 80), 'e-mails: 80% and 100% of the SMS allowance (once each a month)');

await relogin();
// ---- 4. the renewal is declined → past due → retries → grace → suspended
check((await call('PUT', '/api/subscription/v1/account/card', admin, { number: '4000 0000 0000 0002', expiry: '11/29', name: 'Dr Smile' })).last4 === '0002', 'the card is replaced by one the bank will decline');
await internal('POST', `/internal/tenants/${tid}/billing/advance`, { to: 'period-end' });
bill = await internal('GET', `/internal/tenants/${tid}/billing`);
const renewal = fresh(bill).find((i) => i.kind === 'RENEWAL');
const rd = await call('GET', `/api/subscription/v1/account/invoices/${renewal?.id}`, admin);
const smsLine = rd.lines?.find((l) => l.kind === 'USAGE');
check(renewal?.status === 'FAILED' && /declined/.test(renewal.lastError ?? '') && bill.status === 'PAST_DUE', `renewal ${renewal?.number} declined: "${renewal?.lastError}"`);
check(!!smsLine && smsLine.quantity === usage.used - 5 && Math.abs(smsLine.amount - (usage.used - 5) * 0.2) < 0.001 && /beyond 5 included/.test(smsLine.description), `SMS overage on the next invoice: "${smsLine?.description}" ${smsLine?.quantity} × ₹0.20 = ₹${smsLine?.amount}`);
check(rd.discountLabel?.startsWith('WELCOME20'), 'coupon still applies (2nd of 3 invoices)');
c = await capsUntil(admin, (x) => x.billing?.status === 'PAST_DUE');
check(!!c && c.modules.includes('appointments'), 'PAST_DUE: everything still works (banner for the owner)');
check(!!(await inbox(`Payment failed for invoice ${renewal?.number}`, start)), 'e-mail: payment failed, we will retry');
for (let i = 0; i < 3; i++) await internal('POST', `/internal/tenants/${tid}/billing/advance`, { to: 'next-retry' });
bill = await internal('GET', `/internal/tenants/${tid}/billing`);
check(bill.invoices.find((i) => i.id === renewal?.id)?.attempts === 4 && !!bill.graceEndsAt, `3 retries failed → GRACE until ${bill.graceEndsAt?.slice(0, 10)}`);
c = await capsUntil(admin, (x) => x.billing?.status === 'GRACE');
check(!!c && c.modules.includes('appointments') && !!(await inbox('MediCare payment overdue: action needed', start)), 'GRACE: still working; e-mail: overdue, read-only after the grace period');
await internal('POST', `/internal/tenants/${tid}/billing/advance`, { to: 'grace-end' });
c = await capsUntil(admin, (x) => x.billing?.status === 'SUSPENDED');
check(!!c && c.readOnlyModules.includes('appointments') && c.readOnlyModules.includes('directory') && c.modules.includes('core'), `SUSPENDED: read-only (${c?.readOnlyModules.join(', ')}); core still works`);
const docs = await waitFor(async () => { const r = await call('GET', `/api/records/v1/patients/${me.id}/timeline`, patient); return r.status === 200 ? r : null; }, 15000, 700);
const newDoc = await waitFor(async () => { const r = await call('POST', '/api/provider/v1/doctors', admin, { name: 'Dr. Blocked', email: `blocked.${Date.now()}@${SLUG}.test`, registrationNo: `BLK/${Date.now()}`, specialties: [], branches: [] }); return r.code === 'MODULE_READ_ONLY' ? r : null; }, 30000, 1000);
check(!!docs && !!newDoc, 'the patient still reads their health record (200); staff cannot add a doctor (MODULE_READ_ONLY)');
check(!!(await inbox('MediCare subscription suspended', start)), 'e-mail: suspended');
check((await call('POST', '/api/subscription/v1/account/change-plan', admin, { plan: 'CLINIC_PRO' })).code === 'SUBSCRIPTION_INACTIVE', 'no plan changes while suspended');

await relogin();
// ---- 5. the owner pays → active again
const paid = await call('PUT', '/api/subscription/v1/account/card', admin, { number: '4111 1111 1111 1111', expiry: '10/31', name: 'Dr Smile' });
bill = await internal('GET', `/internal/tenants/${tid}/billing`);
check(paid.paidUp === true && fresh(bill).every((i) => i.status === 'PAID') && bill.unpaid.invoices === 0, `new card: every open invoice charged (₹${renewal?.total})`);
c = await capsUntil(admin, (x) => x.billing?.status === 'ACTIVE' && x.modules.includes('appointments'));
check(!!c && !c.readOnlyModules.includes('appointments'), 'ACTIVE again: modules back at once (no data lost)');
check(!!(await inbox('Payment received: subscription active', start)), 'e-mail: payment received');

await relogin();
// ---- 6. upgrade now (prorated), downgrade at the period end
await internal('POST', `/internal/tenants/${tid}/billing/advance`, { to: '+10d' });
const up = await call('POST', '/api/subscription/v1/account/change-plan', admin, { plan: 'CLINIC_PRO' });
const upInv = up.invoice && await call('GET', `/api/subscription/v1/account/invoices/${up.invoice.id}`, admin);
check(up.applied === 'NOW' && upInv?.kind === 'PRORATION' && upInv.lines.some((l) => l.kind === 'CREDIT' && /Unused Clinic Starter/.test(l.description)) && upInv.lines.some((l) => /Clinic Professional \(/.test(l.description)) && upInv._body.status === 'PAID',
  `upgrade to Clinic Professional now: invoice ${upInv?.number} = rest of the month minus unused Starter, ₹${upInv?.total} paid`);
check((await capsUntil(admin, (x) => x.plan?.code === 'CLINIC_PRO')) != null, 'the new plan applies at once');
const down = await call('POST', '/api/subscription/v1/account/change-plan', admin, { plan: 'CLINIC_STARTER' });
check(down.applied === 'AT_PERIOD_END', `downgrade back to Starter scheduled for ${down.at?.slice(0, 10)}`);
check((await caps(admin)).plan?.code === 'CLINIC_PRO', 'nothing changes before the period end');
await internal('POST', `/internal/tenants/${tid}/billing/advance`, { to: 'period-end' });
bill = await internal('GET', `/internal/tenants/${tid}/billing`);
const latest = fresh(bill)[0];
check(bill.plan.code === 'CLINIC_STARTER' && !bill.pendingChange && latest.kind === 'RENEWAL' && latest.status === 'PAID', `at the period end: Clinic Starter; renewal ${latest.number} ₹${latest.total} paid`);

await relogin();
// ---- 7. cancel at the period end
check((await call('POST', '/api/subscription/v1/account/cancel', admin, { cancel: true })).cancelAtPeriodEnd === true, 'owner cancels at the period end');
await internal('POST', `/internal/tenants/${tid}/billing/advance`, { to: 'period-end' });
c = await capsUntil(admin, (x) => x.billing?.status === 'CANCELLED');
check(!!c && c.readOnlyModules.includes('appointments'), 'CANCELLED: read-only, records kept');

await relogin();
// ---- 8. support: the console shows it; a sales-led hospital pays by bank transfer
const sb = await call('GET', `/api/subscription/v1/platform/hospitals/${tid}/billing`, hq, undefined, 'medicare.localhost');
check(sb.billing?.status === 'CANCELLED' && sb.billing.invoices.length >= 4, `console: brightsmile ${sb.billing?.status}, ${sb.billing?.invoices.length} invoices`);
const green = JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' })).find((t) => t.slug === 'greenleaf');
if (green) {
  await internal('POST', `/internal/tenants/${green.id}/billing/advance`, { to: 'period-end' });
  const gb = await internal('GET', `/internal/tenants/${green.id}/billing`);
  const open = gb.invoices.find((i) => i.status === 'OPEN');
  check(gb.paymentMethod?.kind === 'OFFLINE' && !!open && gb.status === 'ACTIVE', `greenleaf (sales-led): renewal ${open?.number} OPEN, waits for a bank transfer, no dunning (${gb.status})`);
  // (earlier runs may have left more open invoices: each gets its transfer recorded)
  let rec = {};
  for (const inv of gb.invoices.filter((i) => i.status === 'OPEN')) rec = await call('POST', `/api/subscription/v1/platform/hospitals/${green.id}/invoices/${inv.id}/paid`, hq, { reference: `NEFT UTR ${inv.number}` }, 'medicare.localhost');
  check(rec.paid === true && (await internal('GET', `/internal/tenants/${green.id}/billing`)).unpaid.invoices === 0, 'support records the bank transfer: paid');
}
check((await call('GET', '/api/subscription/v1/account/subscription', await staffToken('admin@medicare.test', 'medicare'), undefined, 'medicare.localhost')).code === 'NO_SUBSCRIPTION', "MediCare's own account has no subscription");

await relogin();
// ---- clean-up: a fresh trial, no SMS override
await call('PUT', `/api/subscription/v1/platform/hospitals/${tid}/features/core.sms`, hq, { value: null, reason: 'billing test done' }, 'medicare.localhost');
await internal('POST', `/internal/tenants/${tid}/billing/reset-trial`, { days: 14 });

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mbilling ok\x1b[0m');
process.exit(failures ? 1 : 0);
