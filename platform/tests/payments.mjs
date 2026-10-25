#!/usr/bin/env node
// Online payments test (Phase 11), against the local gateway with the simulated Razorpay:
//   pay online → slot HELD → paid → CONFIRMED (checkout callback + duplicated webhooks, processed once);
//   failed attempt, then success; paying twice → the extra payment is refunded; bad signatures refused;
//   hold expiry → EXPIRED + slot reopens; late payment re-takes a free slot, or is refunded if the slot is gone;
//   cancellation refunds (100% ≥ 24 h, 50% under 24 h); counter payment at the desk; manual refund; PDF; isolation.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
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
async function patient(name, host = 'citycare.localhost') {
  const phone = `+9191${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone }, host);
  let code;
  for (let i = 0; i < 30 && !code; i++) {
    await sleep(200);
    const m = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.slice(1)}@sms.medicare.local`)}`)).json();
    code = m.messages?.[0]?.Snippet?.match(/\d{6}/)?.[0];
  }
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code }, host)).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1985-05-05' }, host);
  return { token, phone, self };
}
const waitFor = async (fn, ms = 15000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
const appt = (tok, id) => call('GET', `/api/scheduling/v1/appointments/${id}`, tok);
const invoice = (tok, id) => call('GET', `/api/billing/v1/invoices/${id}`, tok);
const pay = (tok, orderId, outcome = 'success') => call('POST', '/api/billing/v1/payments/simulator/pay', tok, { orderId, outcome, method: 'upi' });

// ---- setup
const A = await patient('Payment Patient A');
const B = await patient('Payment Patient B');
const desk = await staffToken('desk@citycare.test');
const admin = await staffToken('admin@citycare.test');
await sleep(1500);
const doc = (await call('GET', '/api/provider/v1/public/doctors?q=asha')).items[0];
const days = (await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=60`)).days;
const pick = (d, i) => days.at(d).slots.at(i);
const [s1, s2, s3, s4] = [pick(-2, -1), pick(-3, -1), pick(-4, -1), pick(-5, -1)];
const fee = s1.fee;
check(fee > 0, `Dr. Asha Rao's fee is ₹${fee}`);

// ---- 1. pay online: hold, then pay
const b1 = await call('POST', '/api/scheduling/v1/appointments', A.token, { slotId: s1.slotId, patientId: A.self.id, paymentMode: 'ONLINE' }, undefined, idem());
check(b1.status === 201 && b1._body.status === 'PENDING_PAYMENT' && b1.payment?.orderId?.startsWith('order_') && b1.payment.amount === fee, `online booking held: ${b1.appointmentNo} PENDING_PAYMENT, order ${b1.payment?.orderId}, ₹${b1.payment?.amount}`);
check((await call('GET', `/api/scheduling/v1/public/slots/${s1.slotId}`)).available === false, 'the held slot is not bookable by anyone else');
const other = await call('POST', '/api/scheduling/v1/appointments', B.token, { slotId: s1.slotId, patientId: B.self.id }, undefined, idem());
check(other.status === 409 && other.code === 'SLOT_UNAVAILABLE', 'another patient gets 409 for the held slot');
const inv1 = await invoice(A.token, b1.payment.invoiceId);
check(inv1._body.status === 'ISSUED' && inv1.checkout?.orderId === b1.payment.orderId && inv1.checkout.gateway === 'SIMULATED', `invoice ${inv1.invoiceNo} issued with a checkout`);
check((await invoice(B.token, b1.payment.invoiceId)).status === 404, "another patient cannot see it (404)");
check((await call('GET', `/api/billing/v1/invoices/${b1.payment.invoiceId}`, await staffToken('admin@sunrise.test', 'sunrise'), undefined, 'sunrise.localhost')).status === 404, 'another hospital cannot see it (404)');

// signatures
const bodyStr = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_forged', order_id: b1.payment.orderId, amount: fee * 100 } } } });
const forged = await fetch(`${G}/api/billing/v1/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', 'not-the-secret').update(bodyStr).digest('hex') }, body: bodyStr });
check(forged.status === 401, 'a webhook with a wrong signature is refused (401)');
const badVerify = await call('POST', '/api/billing/v1/payments/verify', A.token, { orderId: b1.payment.orderId, paymentId: 'pay_forged123', signature: 'a'.repeat(64) });
check(badVerify.status === 400 && badVerify.code === 'INVALID_SIGNATURE', 'a checkout callback with a wrong signature is refused (400)');

// failed attempt, then success
const failed = await pay(A.token, b1.payment.orderId, 'failure');
check(!!failed.error?.description, `bank declines the first attempt: "${failed.error?.description}"`);
await sleep(2500);
check((await invoice(A.token, b1.payment.invoiceId))._body.status === 'ISSUED', 'invoice still payable after a failed attempt');
const ok = await pay(A.token, b1.payment.orderId);
const verified = await call('POST', '/api/billing/v1/payments/verify', A.token, { orderId: ok.razorpay_order_id, paymentId: ok.razorpay_payment_id, signature: ok.razorpay_signature });
check(verified.status === 200 && verified._body.status === 'PAID', `checkout callback verified → invoice PAID (${verified.payments?.find((p) => p.status === 'CAPTURED')?.method})`);
const confirmed = await waitFor(async () => { const a = await appt(A.token, b1.id); return a._body.status === 'CONFIRMED' && a.paymentStatus === 'PAID' && a; });
check(!!confirmed, 'appointment CONFIRMED and PAID (payment_succeeded → scheduling)');
check((await call('GET', `/api/scheduling/v1/public/slots/${s1.slotId}`)).available === false, 'slot is now booked');
await sleep(3000); // let the duplicated webhooks arrive
check(psql(`SELECT count(*) FROM billing.payments WHERE invoice_id = '${b1.payment.invoiceId}' AND status = 'CAPTURED'`) === '1', 'callback + 2 webhook deliveries → captured exactly once');
check(Number(psql(`SELECT count(*) FROM billing.processed_webhooks`)) > 0, 'webhook retries deduped on the gateway event id');

// paying the same order again → refunded, invoice untouched
const twice = await pay(A.token, b1.payment.orderId);
check(!!twice.razorpay_payment_id, 'patient pays the same order a second time');
const dupRefund = await waitFor(() => psql(`SELECT status FROM billing.refunds WHERE dedupe_key = 'duplicate:${twice.razorpay_payment_id}'`) === 'PROCESSED');
check(!!dupRefund && (await invoice(A.token, b1.payment.invoiceId))._body.status === 'PAID', 'the second payment is refunded automatically; the invoice stays PAID');

// ---- 2. hold expiry; late payment re-takes a free slot / is refunded when the slot is gone
const b2 = await call('POST', '/api/scheduling/v1/appointments', A.token, { slotId: s2.slotId, patientId: A.self.id, paymentMode: 'ONLINE' }, undefined, idem());
const b3 = await call('POST', '/api/scheduling/v1/appointments', A.token, { slotId: s3.slotId, patientId: A.self.id, paymentMode: 'ONLINE' }, undefined, idem());
check(b2._body.status === 'PENDING_PAYMENT' && b3._body.status === 'PENDING_PAYMENT', 'two more online bookings held');
psql(`UPDATE scheduling.appointments SET hold_expires_at = now() - interval '1 minute' WHERE id IN ('${b2.id}','${b3.id}')`);
const expired = await waitFor(async () => (await appt(A.token, b2.id))._body.status === 'EXPIRED' && (await appt(A.token, b3.id))._body.status === 'EXPIRED', 45000, 1000);
check(!!expired, 'hold expiry job: both → EXPIRED');
check((await call('GET', `/api/scheduling/v1/public/slots/${s2.slotId}`)).available === true, 'expired hold: slot open again');
check(!!(await waitFor(async () => (await invoice(A.token, b2.payment.invoiceId))._body.status === 'VOID')), 'unpaid invoice voided');
const taken = await call('POST', '/api/scheduling/v1/appointments', B.token, { slotId: s3.slotId, patientId: B.self.id }, undefined, idem());
check(taken._body.status === 'CONFIRMED', `meanwhile patient B books ${s3.localTime} on that day (pay at the hospital)`);
const late2 = await pay(A.token, b2.payment.orderId);
await call('POST', '/api/billing/v1/payments/verify', A.token, { orderId: late2.razorpay_order_id, paymentId: late2.razorpay_payment_id, signature: late2.razorpay_signature });
check(!!(await waitFor(async () => (await appt(A.token, b2.id))._body.status === 'CONFIRMED')), 'late payment, slot still free → appointment re-confirmed');
const late3 = await pay(A.token, b3.payment.orderId);
check(!!late3.razorpay_payment_id, 'late payment for the slot B took');
const lost = await waitFor(async () => { const a = await appt(A.token, b3.id); const i = await invoice(A.token, b3.payment.invoiceId); return a._body.status === 'EXPIRED' && a.paymentStatus === 'REFUNDED' && i._body.status === 'REFUNDED' && i; }, 20000);
check(!!lost, `slot gone → appointment stays EXPIRED, full refund ₹${lost?.amountRefunded} (${lost?.refunds?.[0]?.reason})`);

// ---- 3. cancellation refunds
const c1 = await call('POST', `/api/scheduling/v1/appointments/${b1.id}/cancel`, A.token, {});
check(c1._body.status === 'CANCELLED', `patient cancels ${b1.appointmentNo} (days ahead)`);
const r100 = await waitFor(async () => { const i = await invoice(A.token, b1.payment.invoiceId); return i._body.status === 'REFUNDED' && i; });
check(r100?.amountRefunded === fee, `≥ 24 h before → 100% refunded (₹${r100?.amountRefunded})`);
check(!!(await waitFor(async () => (await appt(A.token, b1.id)).paymentStatus === 'REFUNDED')), 'appointment shows REFUNDED');
psql(`UPDATE scheduling.appointments SET starts_at = now() + interval '5 hours', ends_at = now() + interval '5 hours 15 minutes' WHERE id = '${b2.id}'`);
await call('POST', `/api/scheduling/v1/appointments/${b2.id}/cancel`, A.token, {});
const r50 = await waitFor(async () => { const i = await invoice(A.token, b2.payment.invoiceId); return i._body.status === 'PARTIALLY_REFUNDED' && i; });
check(r50?.amountRefunded === fee / 2, `5 h before → 50% refunded (₹${r50?.amountRefunded} of ₹${fee})`);

// ---- 4. counter payment at the desk + manual refund
const counterInv = await waitFor(async () => {
  const l = await call('GET', `/api/billing/v1/invoices?q=${encodeURIComponent('Payment Patient B')}`, desk);
  return l.items?.find((i) => i.source.id === taken.id);
});
check(counterInv?.status === 'ISSUED' && counterInv.paymentMode === 'AT_CLINIC', `pay-at-clinic booking got invoice ${counterInv?.invoiceNo} (₹${counterInv?.total})`);
const noRef = await call('POST', '/api/billing/v1/desk/collect', desk, { sourceId: taken.id, method: 'UPI' }, undefined, idem());
check(noRef.status === 422 && noRef.code === 'REFERENCE_REQUIRED', 'UPI at the counter needs the transaction reference');
const cash = await call('POST', '/api/billing/v1/desk/collect', desk, { sourceId: taken.id, method: 'CASH' }, undefined, idem());
check(cash.status === 201 && cash._body.status === 'PAID', 'receptionist collects cash → PAID');
check((await call('POST', '/api/billing/v1/desk/collect', desk, { sourceId: taken.id, method: 'CASH' }, undefined, idem())).code === 'ALREADY_PAID', 'collecting again → 409 ALREADY_PAID');
check(!!(await waitFor(async () => (await appt(desk, taken.id)).paymentStatus === 'PAID')), 'the desk board sees it paid');
check((await call('POST', `/api/billing/v1/invoices/${counterInv.id}/refunds`, desk, { amount: 100, reason: 'goodwill' }, undefined, idem())).status === 403, 'a receptionist cannot issue refunds (403)');
const manual = await call('POST', `/api/billing/v1/invoices/${counterInv.id}/refunds`, admin, { amount: 100, reason: 'Goodwill discount' }, undefined, idem());
check(manual.status === 201, 'admin issues a ₹100 goodwill refund');
check(!!(await waitFor(async () => (await invoice(admin, counterInv.id))._body.status === 'PARTIALLY_REFUNDED')), 'counter refund processed (cash handed back) → PARTIALLY_REFUNDED');
const tooMuch = await call('POST', `/api/billing/v1/invoices/${counterInv.id}/refunds`, admin, { amount: 100000, reason: 'oops' }, undefined, idem());
check(tooMuch.code === 'REFUND_TOO_LARGE', 'refund larger than what is left → 422');
await call('POST', `/api/scheduling/v1/appointments/${taken.id}/cancel`, B.token, {});
const rest = await waitFor(async () => { const i = await invoice(admin, counterInv.id); return i._body.status === 'REFUNDED' && i; });
check(rest?.amountRefunded === counterInv.total, `cancelling then refunds only what is left (₹${counterInv.total - 100}), no error loop`);

// ---- 5. lists, PDF, notifications
const day = await call('GET', '/api/billing/v1/invoices', admin);
check(day.totals.collectedOnline >= fee * 3 && day.totals.collectedAtCounter >= fee && day.totals.refunded > 0, `today: online ₹${day.totals.collectedOnline}, counter ₹${day.totals.collectedAtCounter}, refunded ₹${day.totals.refunded}`);
const mine = await call('GET', '/api/billing/v1/me/invoices', A.token);
check(mine._body.length >= 3 && mine._body.every((i) => i.patient.name === 'Payment Patient A'), `patient sees their ${mine._body.length} invoices only`);
const pdf = await fetch(`${G}/api/billing/v1/invoices/${b1.payment.invoiceId}/pdf`, { headers: { 'x-tenant-host': 'citycare.localhost', authorization: `Bearer ${A.token}` } });
const bytes = Buffer.from(await pdf.arrayBuffer());
check(pdf.headers.get('content-type') === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-', `invoice PDF (${bytes.length} bytes)`);
const sms = await waitFor(async () => {
  const m = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${A.phone.slice(1)}@sms.medicare.local`)}`)).json();
  return (m.messages ?? []).some((x) => /payment of ₹/.test(x.Snippet)) && (m.messages ?? []).some((x) => /refund of ₹/.test(x.Snippet));
}, 20000, 1000);
check(!!sms, 'patient got "payment received" and "refund on its way" SMS');

console.log(failures ? `\x1b[31m${failures} failure(s)\x1b[0m` : '\x1b[32mpayments ok\x1b[0m');
process.exit(failures ? 1 : 0);
