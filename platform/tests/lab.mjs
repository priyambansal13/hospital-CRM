#!/usr/bin/env node
// Lab (Phase 14), against the local gateway:
//   public catalog + slots; patient books a package (pay at the lab) → samples with barcodes → counter payment →
//   lab tech collects by barcode → receives → IN_LAB; reject → new label; capacity per slot; online booking held then
//   paid; doctor orders tests for a patient they treat (others refused) → patient books a time; cancel → refund;
//   timeline + notifications; isolation.
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
const sms = async (phone) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.slice(1)}@sms.medicare.local`)}`)).json()).messages ?? [];
let seq = 0;
async function patient(name) {
  // unique even when several are created in the same millisecond
  const phone = `+9187${String(Date.now()).slice(-5)}${String(seq++ % 10)}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  let code;
  for (let i = 0; i < 30 && !code; i++) { await sleep(200); code = (await sms(phone)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6); }
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1975-07-07', gender: 'FEMALE' });
  return { token, phone, self };
}
const waitFor = async (fn, ms = 20000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };

// ---- setup: a lab technician
const admin = await staffToken('admin@citycare.test');
await call('POST', '/api/iam/v1/staff/invites', admin, { email: 'lab@citycare.test', name: 'Lata Lab', roles: ['LAB_TECH'] }, undefined, idem());
await sleep(1500);
const [lab, desk, asha, other] = await Promise.all([staffToken('lab@citycare.test'), staffToken('desk@citycare.test'), staffToken('asha.rao@citycare.test'), staffToken('leak.doctor@citycare.test')]);
const P = await patient('Lab Patient');

// ---- 1. catalog and slots (public)
const cat = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
const full = cat.packages?.find((p) => p.code === 'FULL_BODY');
check(cat.tests?.length >= 20 && full?.tests.length === 10 && full.price < full.worth, `catalog: ${cat.tests?.length} tests, ${cat.packages?.length} packages; Full Body Checkup ₹${full?.price} (worth ₹${full?.worth})`);
check(/Fast for 10 hours/.test(full?.preparation ?? ''), `package preparation: "${full?.preparation}"`);
check((await call('GET', '/api/diagnostics/v1/public/lab-catalog?q=sugar test'))._body.tests.some((t) => t.code === 'FBS'), 'search by alias: "sugar test" finds Fasting Blood Sugar');
const branches = (await call('GET', '/api/diagnostics/v1/public/lab-branches'))._body;
const branch = branches.find((b) => b.name === 'Sector 44') ?? branches[0];
const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + 86_400_000));
const slots = await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${branch.id}&date=${tomorrow}`);
check(slots.slots?.length > 4 && slots.slots.every((s) => s.left <= 3), `slots at ${branch.name} on ${tomorrow}: ${slots.slots?.length} (${slots.slots?.[0]?.localTime}…)`);
/** a slot with room, from tomorrow on (repeated runs fill the early ones) */
const taken = new Set();
async function freeSlot(minLeft = 1) {
  for (let d = 1; d < 25; d++) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + d * 86_400_000));
    const s = (await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${branch.id}&date=${day}`)).slots?.find((x) => x.left >= minLeft && !taken.has(x.slotAt));
    if (s) { taken.add(s.slotAt); return { ...s, day }; }
  }
  throw new Error('no free lab slot in 25 days');
}
const s0 = await freeSlot();

// ---- 2. book a package, pay at the lab
const past = await call('POST', '/api/diagnostics/v1/lab-orders', P.token, { patientId: P.self.id, branchId: branch.id, slotAt: '2026-01-01T03:00:00Z', items: [{ packageId: full.id }] }, undefined, idem());
if (past.code !== 'SLOT_TOO_SOON') console.log('   →', past.status, JSON.stringify(past._body).slice(0, 300));
check(past.code === 'SLOT_TOO_SOON', 'past time refused');
const offGrid = new Date(Date.parse(s0.slotAt) + 7 * 60_000).toISOString();
check((await call('POST', '/api/diagnostics/v1/lab-orders', P.token, { patientId: P.self.id, branchId: branch.id, slotAt: offGrid, items: [{ packageId: full.id }] }, undefined, idem())).code === 'NOT_A_COLLECTION_TIME', 'a time that is not a collection slot is refused');
const fbs = cat.tests.find((t) => t.code === 'FBS');
const o1 = await call('POST', '/api/diagnostics/v1/lab-orders', P.token, { patientId: P.self.id, branchId: branch.id, slotAt: s0.slotAt, items: [{ packageId: full.id }, { testId: fbs.id }] }, undefined, idem());
check(o1.status === 201 && o1._body.status === 'BOOKED' && o1.total === full.price && o1.tests.length === 10, `booked ${o1.orderNo}: ₹${o1.total} (FBS already in the package is not charged twice), ${o1.tests?.length} tests`);
const kinds = o1.samples?.map((s) => s.sampleType).sort();
check(JSON.stringify(kinds) === JSON.stringify(['BLOOD', 'BLOOD', 'BLOOD', 'URINE']) && o1.samples.every((s) => /^S\d{8}$/.test(s.barcode)), `sample labels: ${o1.samples?.map((s) => `${s.sampleType}/${s.container?.split(' ')[0]} ${s.barcode}`).join(', ')}`);
const bookedSms = await waitFor(async () => (await sms(P.phone)).find((m) => m.Snippet.includes(o1.orderNo)), 20000, 1000);
check(!!bookedSms && /Fast for 10 hours/.test(bookedSms.Snippet) && !/Lipid|HbA1c|Thyroid/i.test(bookedSms.Snippet), `SMS has the preparation, no test names: "${bookedSms?.Snippet.slice(0, 110)}…"`);

// ---- 3. lab bench
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const wl = await call('GET', `/api/diagnostics/v1/lab/worklist?branchId=${branch.id}&date=${s0.day}`, lab);
check(wl.orders?.some((o) => o.id === o1.id), `lab worklist for ${s0.day} shows ${o1.orderNo}`);
check((await call('GET', `/api/diagnostics/v1/lab/worklist?branchId=${branch.id}`, desk)).status === 200 && (await call('POST', '/api/diagnostics/v1/lab/samples/collect', desk, { barcode: o1.samples[0].barcode })).status === 403, 'a receptionist sees the worklist but cannot collect samples');
check((await call('GET', `/api/diagnostics/v1/lab/worklist?branchId=${branch.id}`, P.token)).status === 403, 'patients cannot see the worklist');
check((await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: o1.samples[0].barcode })).code === 'PAYMENT_REQUIRED', 'collection needs the payment first');
// the test runs today: move the booking to today (as if it were tomorrow morning)
const { execFileSync } = await import('node:child_process');
const psql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
psql(`UPDATE diagnostics.lab_orders SET slot_at = now() - interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id = '${o1.id}'`);
const inv = await waitFor(async () => (await call('GET', `/api/billing/v1/invoices?q=${o1.orderNo}`, lab)).items?.[0]) ?? (await waitFor(async () => (await call('GET', `/api/billing/v1/invoices?q=Lab%20Patient`, desk)).items?.find((i) => i.source.id === o1.id)));
const paid = await call('POST', '/api/billing/v1/desk/collect', lab, { sourceType: 'LAB_ORDER', sourceId: o1.id, method: 'UPI', reference: 'UPI123456' }, undefined, idem());
check(paid.status === 201 && paid._body.status === 'PAID', `lab counter takes ₹${paid.total} by UPI (${paid.invoiceNo})`);
check(!!(await waitFor(async () => (await call('GET', `/api/diagnostics/v1/lab-orders/${o1.id}`, P.token)).paymentStatus === 'PAID')), 'order shows paid');
let last;
for (const s of o1.samples) last = await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: s.barcode.toLowerCase() });
check(last.order?.status === 'SAMPLE_COLLECTED' && last.order.samples.every((s) => s.status === 'COLLECTED' && s.collectedBy === 'lab@citycare.test'), 'all 4 tubes scanned → SAMPLE_COLLECTED (who and when recorded)');
check((await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: o1.samples[0].barcode })).code === 'ALREADY_COLLECTED', 'scanning a tube twice → 409');
const rej = await call('POST', '/api/diagnostics/v1/lab/samples/reject', lab, { barcode: o1.samples[0].barcode, reason: 'Haemolysed' });
check(rej.order?.status === 'SAMPLE_REJECTED' && /^S\d{8}$/.test(rej.replacement), `rejected (haemolysed) → new label ${rej.replacement}`);
const recollectSms = await waitFor(async () => (await sms(P.phone)).find((m) => /new sample/.test(m.Snippet)), 20000, 1000);
check(!!recollectSms, 'patient is asked to come back for a new sample (no charge)');
await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: rej.replacement });
let o;
for (const s of (await call('GET', `/api/diagnostics/v1/lab-orders/${o1.id}`, lab)).samples.filter((x) => x.status === 'COLLECTED')) o = await call('POST', '/api/diagnostics/v1/lab/samples/receive', lab, { barcode: s.barcode });
check(o?._body.status === 'IN_LAB', 'every tube received at the bench → IN_LAB');
check((await call('POST', `/api/diagnostics/v1/lab-orders/${o1.id}/cancel`, P.token, {})).code === 'INVALID_STATE_TRANSITION', 'cannot cancel after collection');

// ---- 4. capacity
// an untouched slot a few days out (each run uses a fresh one)
const s1 = await freeSlot(3);
const filler = await Promise.all([0, 1, 2, 3].map(async (i) => { const q = await patient(`Slot Filler ${i}`); return call('POST', '/api/diagnostics/v1/lab-orders', q.token, { patientId: q.self.id, branchId: branch.id, slotAt: s1.slotAt, items: [{ testId: fbs.id }] }, undefined, idem()); }));
console.log('   race:', filler.map((r) => r.status + ' ' + (r.code ?? r._body.status)).join(', '));
check(filler.filter((r) => r.status === 201).length === 3 && filler.filter((r) => r.code === 'SLOT_FULL').length === 1, `4 patients race for a ${s1.left}-place slot → ${filler.filter((r) => r.status === 201).length} booked, ${filler.filter((r) => r.code === 'SLOT_FULL').length} × SLOT_FULL`);

// ---- 5. online payment
const thyroid = cat.packages.find((p) => p.code === 'THYROID');
const on = await call('POST', '/api/diagnostics/v1/lab-orders', P.token, { patientId: P.self.id, branchId: branch.id, slotAt: (await freeSlot()).slotAt, items: [{ packageId: thyroid.id }], paymentMode: 'ONLINE' }, undefined, idem());
check(on._body.status === 'PENDING_PAYMENT' && on.payment?.orderId, `online: held (${on.orderNo}, ₹${on.payment?.amount})`);
const pay = await call('POST', '/api/billing/v1/payments/simulator/pay', P.token, { orderId: on.payment.orderId, outcome: 'success', method: 'upi' });
await call('POST', '/api/billing/v1/payments/verify', P.token, { orderId: pay.razorpay_order_id, paymentId: pay.razorpay_payment_id, signature: pay.razorpay_signature });
check(!!(await waitFor(async () => { const x = await call('GET', `/api/diagnostics/v1/lab-orders/${on.id}`, P.token); return x._body.status === 'BOOKED' && x.paymentStatus === 'PAID'; })), 'paid → BOOKED');
await call('POST', `/api/diagnostics/v1/lab-orders/${on.id}/cancel`, P.token, {});
check(!!(await waitFor(async () => (await call('GET', `/api/diagnostics/v1/lab-orders/${on.id}`, P.token)).paymentStatus === 'REFUNDED')), 'cancelled before collection → full refund');

// ---- 6. doctor orders tests
const appt = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: P.self.id, walkIn: { doctorId: (await call('GET', '/api/scheduling/v1/me/doctor', asha)).id, branchId: branch.id } }, undefined, idem());
const hba1c = cat.tests.find((t) => t.code === 'HBA1C');
check((await call('POST', '/api/diagnostics/v1/doctor/lab-orders', other, { patientId: P.self.id, items: [{ testId: hba1c.id }] }, undefined, idem())).status === 403, 'a doctor who is not treating the patient cannot order tests');
const dor = await waitFor(async () => { const r = await call('POST', '/api/diagnostics/v1/doctor/lab-orders', asha, { patientId: P.self.id, items: [{ testId: hba1c.id }, { testId: fbs.id }], note: 'Review diabetes control' }, undefined, idem()); return r.status === 201 && r; });
check(dor?._body.status === 'AWAITING_BOOKING' && dor.orderedBy?.name === 'Dr. Asha Rao', `Dr. Asha Rao orders HbA1c + FBS (${dor?.orderNo}, waiting for the patient to book)`);
const ask = await waitFor(async () => (await sms(P.phone)).find((m) => /has requested lab tests/.test(m.Snippet)), 20000, 1000);
check(!!ask, 'patient is told their doctor requested tests');
const sch = await call('POST', `/api/diagnostics/v1/lab-orders/${dor.id}/schedule`, P.token, { branchId: branch.id, slotAt: (await freeSlot()).slotAt, paymentMode: 'AT_CLINIC' });
if (sch.status !== 200) console.log('   schedule →', sch.status, JSON.stringify(sch._body).slice(0, 250));
check(sch._body.status === 'BOOKED' && sch.samples.length === 2, `patient picks a time → BOOKED with ${sch.samples?.length} labels (EDTA + fluoride)`);
const tl = await waitFor(async () => { const t = await call('GET', `/api/records/v1/patients/${P.self.id}/timeline?kind=LAB_ORDER`, P.token); return t.items?.length >= 3 && t; });
check(!!tl, `timeline: ${tl?.items.map((i) => i.title.slice(0, 40)).join(' | ')}`);
const mine = await call('GET', '/api/diagnostics/v1/me/lab-orders', P.token);
check(mine._body.length >= 3, `patient sees ${mine._body.length} lab orders`);

// ---- 7. isolation
const sun = await staffToken('admin@sunrise.test', 'sunrise');
check((await call('GET', `/api/diagnostics/v1/lab-orders/${o1.id}`, sun, undefined, 'sunrise.localhost')).status === 404, 'another hospital: 404');
check((await call('GET', `/api/diagnostics/v1/lab-orders/${o1.id}`, (await patient('Nosy Patient')).token)).status === 404, "another patient: 404");

console.log(failures ? `\x1b[31m${failures} failure(s)\x1b[0m` : '\x1b[32mlab ok\x1b[0m');
process.exit(failures ? 1 : 0);
