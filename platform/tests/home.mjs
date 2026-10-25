#!/usr/bin/env node
// Home sample collection (Phase 16), against the local gateway:
//   pincodes served (+ fee) → home visit times → patient books at home (fee added; scans refused; capacity) → the lab
//   assigns a phlebotomist (one home at a time) → on the way → arrived → payment at home → tubes scanned → collected →
//   hand-over at the lab bench; a missed visit goes back to the patient to rebook; module switched off → no home booking.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
const mc = (...args) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...args], { encoding: 'utf8' });
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
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
const waitFor = async (fn, ms = 20000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
let seq = 0;
async function patient(name) {
  const phone = `+9183${String(Date.now()).slice(-5)}${seq++ % 10}${String(Math.floor(Math.random() * 90) + 10)}`;
  const since = Date.now() - 1000;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const code = await waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => Date.parse(m.Created) >= since && /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6), 15000, 250);
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1968-03-03', gender: 'MALE' });
  return { token, phone, self };
}
const ist = (offsetDays) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offsetDays * 86_400_000));
const smsTo = (phone, re) => waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => re.test(m.Snippet)), 20000, 1000);
/** move an order and its visit to "now" so the visit can happen today */
const today = (orderId) => psql(`UPDATE diagnostics.lab_orders SET slot_at = now() + interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id = '${orderId}';
  UPDATE diagnostics.home_visits SET slot_at = now() + interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE order_id = '${orderId}'`);

// ---- setup: lab technician, two phlebotomists, the Sector 44 branch
const admin = await staffToken('admin@citycare.test');
for (const [email, name, roles] of [['lab@citycare.test', 'Lata Lab', ['LAB_TECH']], ['ravi.phleb@citycare.test', 'Ravi Kumar', ['PHLEBOTOMIST']], ['sunil.phleb@citycare.test', 'Sunil Verma', ['PHLEBOTOMIST']]]) {
  await call('POST', '/api/iam/v1/staff/invites', admin, { email, name, roles }, undefined, idem());
}
await sleep(1500);
const [lab, ravi, sunil] = await Promise.all(['lab', 'ravi.phleb', 'sunil.phleb'].map((u) => staffToken(`${u}@citycare.test`)));
const raviId = JSON.parse(Buffer.from(ravi.split('.')[1], 'base64url')).sub;
const sunilId = JSON.parse(Buffer.from(sunil.split('.')[1], 'base64url')).sub;
const branch = (await call('GET', '/api/diagnostics/v1/public/lab-branches'))._body.find((b) => b.name === 'Sector 44');
const cat = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
const T = (code) => cat.tests.find((t) => t.code === code);
const PIN = '122003';

// ---- 1. pincodes served
check((await call('POST', '/api/diagnostics/v1/admin/home-areas', lab, { pincode: PIN, branchId: branch.id, fee: 100 })).status === 403, 'a lab technician cannot change the areas served');
const area = await call('POST', '/api/diagnostics/v1/admin/home-areas', admin, { pincode: PIN, branchId: branch.id, area: 'Sector 44, Gurugram', fee: 100 });
check(area.status === 200 && area.fee === 100 && area.branch.name === 'Sector 44', `admin: ${PIN} served by Sector 44, visit fee ₹100`);
await call('POST', '/api/diagnostics/v1/admin/home-areas', admin, { pincode: '122018', branchId: branch.id, area: 'Sohna Road', fee: 0 });
const yes = await call('GET', `/api/diagnostics/v1/public/home-collection/check?pincode=${PIN}`);
const no = await call('GET', '/api/diagnostics/v1/public/home-collection/check?pincode=110001');
check(yes.serviceable && yes.fee === 100 && no.serviceable === false, `pincode check: ${PIN} yes (₹100), 110001 not served`);
check((await call('GET', '/api/diagnostics/v1/public/home-collection/check?pincode=12345')).status === 400, 'an invalid pincode is refused');
const wins = await call('GET', `/api/diagnostics/v1/admin/home-windows/${branch.id}`, admin);
check(wins._body.length === 7 && wins._body[0].start === '06:30' && wins._body[0].slotMinutes === 30, 'default home visit times: 06:30–10:30 Mon–Sat in 30-minute visits, 07:00–09:00 Sun');

// ---- 2. home visit times
let day, slot;
for (let d = 1; d < 25 && !slot; d++) {
  day = ist(d);
  const r = await call('GET', `/api/diagnostics/v1/public/home-collection/slots?pincode=${PIN}&date=${day}`);
  slot = r.slots?.find((s) => s.left === 2);
}
check(!!slot && /^(0[6-9]|10):[03]0$/.test(slot.localTime), `free home visit on ${day} at ${slot?.localTime} (2 places)`);

// ---- 3. booking at home
const P = await patient('Home Patient');
const address = { line1: 'House 12, Lane 3', landmark: 'near the park', city: 'Gurugram', pincode: PIN, phone: P.phone };
const book = (who, items, a = address, s = slot.slotAt, paymentMode = 'AT_CLINIC') => call('POST', '/api/diagnostics/v1/lab-orders', who.token, { patientId: who.self.id, home: a, slotAt: s, items, paymentMode }, undefined, idem());
check((await book(P, [{ testId: T('CBC').id }], { ...address, pincode: '110001' })).code === 'PINCODE_NOT_SERVED', 'a pincode we do not serve is refused');
check((await book(P, [{ testId: T('XRAY_CHEST').id }])).code === 'NOT_HOME_COLLECTABLE', 'an X-ray cannot be booked at home');
const soon = (await call('GET', `/api/diagnostics/v1/public/home-collection/slots?pincode=${PIN}&date=${ist(0)}`)).slots ?? [];
check(soon.every((s) => Date.parse(s.slotAt) > Date.now() + 115 * 60_000), 'home visits start at least 2 hours from now');
const o1 = await book(P, [{ testId: T('CBC').id }, { testId: T('FBS').id }]);
const expected = T('CBC').price + T('FBS').price + 100;
check(o1.status === 201 && o1.collectionType === 'HOME' && o1.total === expected && o1.lines.some((l) => l.kind === 'HOME_VISIT' && l.price === 100), `booked ${o1.orderNo} at home: CBC + FBS + home collection = ₹${o1.total}`);
check(o1.homeVisit?.status === 'UNASSIGNED' && o1.homeAddress?.landmark === 'near the park' && o1.branch.name === 'Sector 44', 'visit waiting for a phlebotomist; address kept; served by Sector 44');
const booked = await smsTo(P.phone, new RegExp(`${o1.orderNo}.*`));
check(!!booked && /home/.test(booked.Snippet) && !/CBC|blood count|sugar/i.test(booked.Snippet), `SMS: "${booked?.Snippet.slice(0, 95)}…"`);
const Q = await patient('Home Neighbour');
const o2 = await book(Q, [{ testId: T('FBS').id }], { ...address, line1: 'House 14, Lane 3', phone: Q.phone });
const R = await patient('Home Third');
check(o2.status === 201 && (await book(R, [{ testId: T('FBS').id }], { ...address, line1: 'House 16', phone: R.phone })).code === 'SLOT_FULL', 'two visits fill the time; a third is refused (SLOT_FULL)');
const atLab = (await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${branch.id}&date=${day}`)).slots.find((s) => s.slotAt === slot.slotAt);
const labTaken = Number(psql(`SELECT count(*) FROM diagnostics.lab_orders WHERE branch_id = '${branch.id}' AND collection_type = 'AT_LAB' AND slot_at = '${slot.slotAt}' AND status IN ('PENDING_PAYMENT','BOOKED','SAMPLE_COLLECTED','IN_LAB','SAMPLE_REJECTED')`));
check(!atLab || atLab.left === 3 - labTaken, `home visits do not use up places at the lab counter (${slot.localTime} at the lab: ${atLab ? `${atLab.left} left` : 'not a lab time'})`);

// ---- 4. the lab cannot scan a home order at the counter
check((await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: o1.samples[0].barcode })).code === 'HOME_COLLECTION', 'the lab counter cannot collect a home order\'s tube');

// ---- 5. dispatch
check((await call('GET', `/api/diagnostics/v1/lab/home-visits?branchId=${branch.id}&date=${day}`, P.token)).status === 403, 'patients cannot see the dispatch board');
const board = await waitFor(async () => { const b = await call('GET', `/api/diagnostics/v1/lab/home-visits?branchId=${branch.id}&date=${day}`, lab); return b.phlebotomists?.some((p) => p.id === raviId) && b.phlebotomists.some((p) => p.id === sunilId) && b; });
const v1 = board?.visits.find((v) => v.orderId === o1.id);
const v2 = board?.visits.find((v) => v.orderId === o2.id);
check(!!v1 && v1.status === 'UNASSIGNED' && board.totals.unassigned >= 2, `board for ${day}: ${board?.visits.length} visit(s), phlebotomists ${board?.phlebotomists.map((p) => p.name).join(', ')}`);
check((await call('POST', `/api/diagnostics/v1/lab/home-visits/${v1.id}/assign`, lab, { phlebotomistId: crypto.randomUUID() })).code === 'NOT_A_PHLEBOTOMIST', 'only phlebotomists can be sent');
const a1 = await call('POST', `/api/diagnostics/v1/lab/home-visits/${v1.id}/assign`, lab, { phlebotomistId: raviId });
check(a1.status === 200 && a1._body.status === 'ASSIGNED' && a1.phlebotomist.name === 'Ravi Kumar', 'assigned to Ravi Kumar');
check((await call('POST', `/api/diagnostics/v1/lab/home-visits/${v2.id}/assign`, lab, { phlebotomistId: raviId })).code === 'PHLEBOTOMIST_BUSY', 'Ravi cannot be in two homes at the same time');
check((await call('POST', `/api/diagnostics/v1/lab/home-visits/${v2.id}/assign`, lab, { phlebotomistId: sunilId }))._body.status === 'ASSIGNED', 'the neighbour goes to Sunil Verma');
const assignedSms = await smsTo(P.phone, /Ravi Kumar will collect/);
check(!!assignedSms, `patient told who is coming: "${assignedSms?.Snippet.slice(0, 90)}…"`);
check(!!(await waitFor(async () => (await mail('to:ravi.phleb@citycare.test')).find((m) => (m.Subject ?? '').includes(o1.orderNo)), 20000, 1000)), 'Ravi gets an email about the new visit');

// ---- 6. Ravi's visit (moved to today)
check((await call('POST', `/api/diagnostics/v1/home-visits/${v1.id}/start`, ravi)).code === 'NOT_TODAY', 'a visit cannot start on another day');
today(o1.id);
const mine = await call('GET', '/api/diagnostics/v1/home-visits/mine', ravi);
const mv = mine.visits?.find((v) => v.id === v1.id);
check(mv?.address?.line1 === 'House 12, Lane 3' && mv.address.phone === P.phone && mv.order.samples.length === 2 && /Fast/.test(mv.order.preparation ?? ''), `Ravi's day: ${mine.visits?.length} visit(s) with address, phone, preparation and ${mv?.order.samples.length} tube labels`);
check((await call('GET', '/api/diagnostics/v1/home-visits/mine', lab)).status === 403, 'only phlebotomists have "my visits"');
check((await call('POST', `/api/diagnostics/v1/home-visits/${v1.id}/start`, sunil)).status === 404, 'Sunil cannot act on Ravi\'s visit');
check((await call('POST', `/api/diagnostics/v1/home-visits/${v1.id}/collect`, ravi, { barcode: o1.samples[0].barcode })).code === 'INVALID_STATE_TRANSITION', 'tubes are collected only after arriving');
check((await call('POST', `/api/diagnostics/v1/home-visits/${v1.id}/start`, ravi))._body.status === 'EN_ROUTE', 'Ravi sets off');
check(!!(await smsTo(P.phone, /is on the way/)), 'patient: "Ravi Kumar is on the way"');
check((await call('POST', `/api/diagnostics/v1/lab-orders/${o1.id}/cancel`, P.token, { reason: null })).code === 'COLLECTOR_ON_THE_WAY', 'the patient cannot cancel once the collector is on the way');
check((await call('POST', `/api/diagnostics/v1/home-visits/${v1.id}/arrive`, ravi))._body.status === 'ARRIVED', 'Ravi arrives');
check((await call('POST', `/api/diagnostics/v1/home-visits/${v1.id}/collect`, ravi, { barcode: o1.samples[0].barcode })).code === 'PAYMENT_REQUIRED', 'payment first');
const pay = await waitFor(async () => { const r = await call('POST', '/api/billing/v1/desk/collect', ravi, { sourceType: 'LAB_ORDER', sourceId: o1.id, method: 'UPI', reference: 'UPI-HOME-1' }, undefined, idem()); return r.status === 201 && r; });
check(pay?._body.status === 'PAID' && pay.total === expected, `Ravi takes ₹${pay?.total} by UPI at the door (${pay?.invoiceNo})`);
await waitFor(async () => (await call('GET', `/api/diagnostics/v1/lab-orders/${o1.id}`, P.token)).paymentStatus === 'PAID');
check((await call('POST', `/api/diagnostics/v1/home-visits/${v1.id}/collect`, ravi, { barcode: o2.samples[0].barcode })).code === 'WRONG_PATIENT', 'the neighbour\'s tube is refused (wrong patient)');
const c1 = await call('POST', `/api/diagnostics/v1/home-visits/${v1.id}/collect`, ravi, { barcode: o1.samples[0].barcode });
const c2 = await call('POST', `/api/diagnostics/v1/home-visits/${v1.id}/collect`, ravi, { barcode: o1.samples[1].barcode });
check(c1.pendingSamples === 1 && c2.pendingSamples === 0 && c2.visit.status === 'COLLECTED', 'both tubes scanned → visit collected');
const after = await call('GET', `/api/diagnostics/v1/lab-orders/${o1.id}`, P.token);
check(after._body.status === 'SAMPLE_COLLECTED' && after.samples.every((s) => s.collectedBy === 'ravi.phleb@citycare.test' || s.status === 'COLLECTED') && after.homeVisit.status === 'COLLECTED', 'order: sample collected; the patient sees "collected"');

// ---- 7. hand-over at the lab
let rec;
for (const s of o1.samples) rec = await call('POST', '/api/diagnostics/v1/lab/samples/receive', lab, { barcode: s.barcode });
check(rec.status === 200 && rec._body.status === 'IN_LAB' && rec.homeVisit.status === 'HANDED_OVER', 'lab receives the tubes → in the lab; visit handed over');
const log = (await call('GET', '/api/diagnostics/v1/home-visits/mine', ravi)).visits?.find((v) => v.id === v1.id)?.log.map((l) => l.status).join(' → ');
check(log === 'UNASSIGNED → ASSIGNED → EN_ROUTE → ARRIVED → COLLECTED → HANDED_OVER', `visit history: ${log}`);

// ---- 8. a missed visit
today(o2.id);
await call('POST', `/api/diagnostics/v1/home-visits/${v2.id}/start`, sunil);
await call('POST', `/api/diagnostics/v1/home-visits/${v2.id}/arrive`, sunil);
const miss = await call('POST', `/api/diagnostics/v1/home-visits/${v2.id}/miss`, sunil, { reason: 'patient not at home' });
check(miss._body.status === 'MISSED' && miss.missedReason === 'patient not at home', 'Sunil: patient not at home → missed');
const back = await call('GET', `/api/diagnostics/v1/lab-orders/${o2.id}`, Q.token);
check(back._body.status === 'AWAITING_BOOKING' && back.homeVisit.status === 'MISSED', 'the order goes back to the patient to pick a new time');
check(!!(await smsTo(Q.phone, /could not collect/)), 'patient: "we could not collect … pick a new time"');
check((await call('POST', `/api/diagnostics/v1/lab-orders/${o2.id}/schedule`, Q.token, { branchId: branch.id, slotAt: slot.slotAt })).code === 'HOME_ORDER', 'a home order is rebooked at home (or cancelled)');
let slot2;
for (let d = 2; d < 25 && !slot2; d++) slot2 = (await call('GET', `/api/diagnostics/v1/public/home-collection/slots?pincode=${PIN}&date=${ist(d)}`)).slots?.find((s) => s.left > 0);
const re = await call('POST', `/api/diagnostics/v1/lab-orders/${o2.id}/schedule`, Q.token, { home: { ...address, line1: 'House 14, Lane 3', phone: Q.phone }, slotAt: slot2.slotAt, paymentMode: 'AT_CLINIC' });
check(re.status === 200 && re._body.status === 'BOOKED' && re.homeVisit.status === 'UNASSIGNED' && re.homeVisit.attempts === 2 && re.total === T('FBS').price + 100, `rebooked for ${re.localDate} ${re.localTime} (attempt 2, fee charged once)`);
const cx = await call('POST', `/api/diagnostics/v1/lab-orders/${o2.id}/cancel`, Q.token, { reason: null });
check(cx._body.status === 'CANCELLED' && cx.homeVisit.status === 'CANCELLED', 'patient cancels → the visit is cancelled');

// ---- 9. module off
mc('module', 'disable', 'citycare', 'home_collection');
await sleep(1500);
const off = await call('GET', `/api/diagnostics/v1/public/home-collection/check?pincode=${PIN}`);
const offBook = await book(R, [{ testId: T('FBS').id }], { ...address, phone: R.phone }, slot2.slotAt);
mc('module', 'reset', 'citycare', 'home_collection');
check([403, 404].includes(off.status) && offBook.code === 'HOME_COLLECTION_OFF', `module switched off → pincode check ${off.status}, home booking refused`);

// ---- 10. audit
await sleep(1500);
const audit = await call('GET', `/api/audit/v1/audit?patientId=${P.self.id}`, admin);
const kinds = new Set((audit.items ?? []).map((e) => `${e.action}:${e.resourceType}`));
check([...kinds].some((k) => k.includes('HOME_VISIT')), `audited: ${[...kinds].filter((k) => /HOME|SAMPLE/.test(k)).join(', ')}`);

console.log(failures ? `\x1b[31m${failures} failure(s)\x1b[0m` : '\x1b[32mhome collection ok\x1b[0m');
process.exit(failures ? 1 : 0);
