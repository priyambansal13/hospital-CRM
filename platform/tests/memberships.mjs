#!/usr/bin/env node
// Patient memberships (Phase 26), against the local gateway with the simulated Razorpay, on citycare:
//   module on → template tiers; admin edits tiers (desk cannot); a non-member is held to the free booking window and
//   kept off members-only times; joining is paid like a bill → ACTIVE at once (cached benefits dropped); the member books
//   further ahead and the held times; lab discount line; renewing extends, switching tier is refused; module reset.
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

try {
  // ---- 1. module on → template tiers
  mc('module', 'enable', 'citycare', 'memberships');
  const plans = await waitFor(async () => { const r = await call('GET', '/api/billing/v1/public/membership-plans'); return r.http === 200 && r.list?.length ? r.list : null; }, 30000, 1000);
  const care = plans?.find((p) => p.code === 'CARE_PLUS');
  const family = plans?.find((p) => p.code === 'FAMILY_PLUS');
  check(!!care && !!family, `module on: template tiers ${plans?.map((p) => `${p.name} ₹${p.price}`).join(', ')}`);

  const admin = await staffToken('admin@citycare.test');
  const desk = await staffToken('desk@citycare.test');
  check((await call('GET', '/api/billing/v1/membership-plans', desk)).http === 403, 'the front desk cannot change tiers');
  const code = `T${Date.now().toString().slice(-6)}`;
  const made = await call('POST', '/api/billing/v1/membership-plans', admin, { code, name: 'Test Gold', price: 2999, period: 'YEARLY', active: false, benefits: { bookingWindowDays: 60, priorityAccess: true, freeVideoConsultsPerMonth: 0, labDiscountPct: 5, freeHomeCollection: false, familyMembers: 1 } });
  check(made.http === 201 || made.http === 200, `admin adds a tier (${made.name}, hidden)`);
  check(!(await call('GET', '/api/billing/v1/public/membership-plans')).list.some((p) => p.code === code), 'a hidden tier is not offered to patients');
  check((await call('PATCH', `/api/billing/v1/membership-plans/${made.id}`, admin, { price: 1999, version: made.version - 1 })).http === 409, 'editing a stale copy of a tier is refused (409)');
  check((await call('POST', '/api/billing/v1/membership-plans', admin, { code: 'BAD', name: 'Bad', price: 10, period: 'MONTHLY', benefits: { ...care.benefits, labDiscountPct: 90 } })).http === 400, 'benefits are bounded (90% lab discount refused)');

  // ---- 2. non-member: free window + members-only times
  const A = await patient('Member Patient A');
  const doc = (await call('GET', '/api/provider/v1/public/doctors?q=asha')).items[0];
  const days = (await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=40`)).days ?? [];
  const all = days.flatMap((d) => d.slots);
  const held = all.filter((s) => s.membersOnly);
  const soon = (s) => Date.parse(s.startsAt) < Date.now() + 13 * 86_400_000;
  check(held.length > 0 && held.length < all.length * 0.4 && held.every((s) => Date.parse(s.startsAt) > Date.now() + 24 * 3_600_000), `${held.length} of ${all.length} times are marked members-only, none within 24 h`);
  const far = all.find((s) => !s.membersOnly && Date.parse(s.startsAt) > Date.now() + 16 * 86_400_000 && Date.parse(s.startsAt) < Date.now() + 29 * 86_400_000);
  const heldSoon = held.find(soon);
  const r1 = await call('POST', '/api/scheduling/v1/appointments', A.token, { slotId: far?.slotId, patientId: A.self.id, paymentMode: 'AT_CLINIC' });
  check(r1.http === 422 && r1.code === 'BOOKING_WINDOW', `a non-member cannot book ${far ? Math.round((Date.parse(far.startsAt) - Date.now()) / 86_400_000) : '?'} days ahead (${r1.code}: ${r1.detail ?? r1.message})`);
  const r2 = await call('POST', '/api/scheduling/v1/appointments', A.token, { slotId: heldSoon?.slotId, patientId: A.self.id, paymentMode: 'AT_CLINIC' });
  check(r2.http === 409 && r2.code === 'MEMBERS_ONLY', 'a non-member cannot take a members-only time');
  const deskBook = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { slotId: far?.slotId, patientId: A.self.id });
  check(deskBook.http !== 422 || deskBook.code !== 'BOOKING_WINDOW', `the front desk is not held to the window (${deskBook.http} ${deskBook.code ?? 'ok'})`);
  if (deskBook.id) await call('POST', `/api/scheduling/v1/appointments/${deskBook.id}/cancel`, desk, {});

  // ---- 3. join: paid like a bill → ACTIVE
  check((await call('POST', '/api/billing/v1/memberships', desk, { planId: care.id })).http === 403, 'staff cannot buy a membership');
  const join = await call('POST', '/api/billing/v1/memberships', A.token, { planId: care.id });
  check(join.http === 201 && !!join.invoiceId, `join Care+ → invoice opened`);
  const inv = await call('GET', `/api/billing/v1/invoices/${join.invoiceId}`, A.token);
  check(inv.source?.type === 'MEMBERSHIP' && inv.total === care.price && inv.branch?.name === 'Membership', `invoice ${inv.invoiceNo}: ₹${inv.total}, no branch`);
  const paid = await call('POST', '/api/billing/v1/payments/simulator/pay', A.token, { orderId: inv.checkout?.orderId, outcome: 'success', method: 'upi' });
  check(paid.http === 200 || paid.http === 201, 'paid (simulated UPI)');
  const mine = await waitFor(async () => { const m = await call('GET', '/api/billing/v1/me/membership', A.token); return m.membership?.status === 'ACTIVE' ? m : null; }, 30000, 1000);
  const days30 = mine ? Math.round((Date.parse(mine.membership.endsAt) - Date.now()) / 86_400_000) : 0;
  check(!!mine && days30 >= 29 && days30 <= 31, `membership ACTIVE until ${mine?.membership.endsAt?.slice(0, 10)} (${days30} days)`);
  const members = await call('GET', '/api/billing/v1/members', admin);
  check(members.list?.some((m) => m.patientName === 'Member Patient A' && m.status === 'ACTIVE'), 'the admin sees the new member');

  // ---- 4. member benefits in booking (cache dropped on the membership event)
  const ok1 = await waitFor(async () => { const r = await call('POST', '/api/scheduling/v1/appointments', A.token, { slotId: far.slotId, patientId: A.self.id, paymentMode: 'AT_CLINIC' }); return r.http === 201 ? r : null; }, 15000, 1000);
  check(!!ok1, 'the member books the far-ahead time (30-day window)');
  if (ok1) await call('POST', `/api/scheduling/v1/appointments/${ok1.id}/cancel`, A.token, {});
  const ok2 = await call('POST', '/api/scheduling/v1/appointments', A.token, { slotId: heldSoon.slotId, patientId: A.self.id, paymentMode: 'AT_CLINIC' });
  check(ok2.http === 201, 'the member books a members-only time');
  if (ok2.id) await call('POST', `/api/scheduling/v1/appointments/${ok2.id}/cancel`, A.token, {});

  // ---- 5. lab discount
  const cat = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
  const fbs = cat.tests.find((t) => t.code === 'FBS');
  const branches = (await call('GET', '/api/diagnostics/v1/public/lab-branches')).list;
  let slotAt;
  for (let d = 1; d < 20 && !slotAt; d++) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + d * 86_400_000));
    slotAt = (await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${branches[0].id}&date=${day}`)).slots?.find((x) => x.left > 0)?.slotAt;
  }
  const lab = await call('POST', '/api/diagnostics/v1/lab-orders', A.token, { patientId: A.self.id, branchId: branches[0].id, slotAt, items: [{ testId: fbs.id }] });
  const disc = lab.lines?.find((l) => l.kind === 'DISCOUNT');
  check(!!disc && Math.abs(lab.total - Math.round(fbs.price * (100 - care.benefits.labDiscountPct)) / 100) < 0.01, `lab order ₹${fbs.price} → ₹${lab.total} ("${disc?.name}")`);
  if (lab.id) await call('POST', `/api/diagnostics/v1/lab-orders/${lab.id}/cancel`, A.token, {});

  // ---- 6. renew extends; switching tier refused
  check((await call('POST', '/api/billing/v1/memberships', A.token, { planId: family.id })).code === 'ALREADY_MEMBER', 'switching tier while a membership runs is refused');
  const renew = await call('POST', '/api/billing/v1/memberships', A.token, { planId: care.id });
  const rinv = await call('GET', `/api/billing/v1/invoices/${renew.invoiceId}`, A.token);
  await call('POST', '/api/billing/v1/payments/simulator/pay', A.token, { orderId: rinv.checkout?.orderId, outcome: 'success', method: 'upi' });
  const ext = await waitFor(async () => { const m = await call('GET', '/api/billing/v1/me/membership', A.token); return Date.parse(m.membership?.endsAt) > Date.parse(mine.membership.endsAt) + 20 * 86_400_000 ? m : null; }, 30000, 1000);
  check(!!ext, `renewing adds a month from the current end (until ${ext?.membership.endsAt?.slice(0, 10)})`);
} finally {
  // ---- 7. back to the plan: other suites expect no booking window
  mc('module', 'reset', 'citycare', 'memberships');
  await sleep(2000);
  const after = await call('GET', '/api/billing/v1/public/membership-plans');
  check(after.http === 403 || after.http === 404, `module reset: memberships closed (${after.http})`);
}
console.log(failures ? `\x1b[31m${failures} check(s) failed\x1b[0m` : '\x1b[32mmemberships: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
