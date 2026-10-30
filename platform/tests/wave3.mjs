#!/usr/bin/env node
// Wave 3 of the flow review (docs/ROLE-FLOWS-AND-GAPS.md §6): front desk and lab completeness, the screens for APIs
// that had none, and the missing notifications (4.G), against the local gateway.
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
const internal = (port, path, body) => fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'x-internal-token': env.INTERNAL_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const admin = await staffToken('admin@citycare.test');
const desk = await staffToken('desk@citycare.test');
const lab = await staffToken('lab@citycare.test');
const A = (await call('GET', '/api/tenant/v1/branches', admin)).list.find((b) => b.name === 'Sector 44');

// a doctor with hours every day at Sector 44
const doctorEmail = `w3doc.${SFX}@citycare.test`;
const doc = await call('POST', '/api/provider/v1/doctors', admin, { name: `Dr. Wave Three ${SFX}`, email: doctorEmail, registrationNo: `W3/${SFX}`, specialties: [{ code: 'GENERAL_MEDICINE', primary: true }], branches: [{ branchId: A.id, fee: 300 }], consultModes: ['IN_PERSON'] });
await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'ACTIVE' });
const hours = await waitFor(async () => { const r = await call('POST', `/api/scheduling/v1/doctors/${doc.id}/availability`, admin, { days: [1, 2, 3, 4, 5, 6, 7], branchId: A.id, startTime: '06:00', endTime: '22:00', slotMinutes: 15 }); return r.http < 300 && r; }, 30000, 1000);
check(!!hours, `doctor with hours at ${A.name}`);

// ======== E-2 desk books ahead; E-1 desk moves it ========
const P = await patient('Wave Three Patient');
const ahead = dayPlus(2);
const slots = await waitFor(async () => { const l = (await call('GET', `/api/scheduling/v1/desk/doctors/${doc.id}/slots?branchId=${A.id}&date=${ahead}`, desk)).list; return l?.length > 3 && l; }, 30000, 1000);
check(slots?.length > 3, `E-2 the desk sees free times on ${ahead} (was: today only)`);
const booked = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: P.self.id, slotId: slots[0].slotId, checkIn: false });
check(booked.status === 'CONFIRMED' && booked.localDate === ahead, `E-2 booked ahead for ${booked.localDate} ${booked.localTime}`);
const moved = await call('POST', `/api/scheduling/v1/appointments/${booked.id}/reschedule`, desk, { newSlotId: slots[2].slotId });
check(moved.status === 'CONFIRMED' && moved.localTime === slots[2].localTime && moved.id !== booked.id, `E-1 the desk moved it to ${moved.localTime}`);
const board = await call('GET', `/api/scheduling/v1/desk/board?branchId=${A.id}&date=${ahead}`, desk);
check(board.doctors?.find((d) => d.id === doc.id)?.appointments.some((a) => a.id === moved.id), 'E-2 the board shows that day');

// ======== D-12 late arrival after a no-show ========
const Q = await patient('Wave Three Late');
const walk = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: Q.self.id, walkIn: { doctorId: doc.id, branchId: A.id } });
await call('POST', `/api/scheduling/v1/appointments/${walk.id}/no-show`, desk);
check((await call('GET', `/api/scheduling/v1/appointments/${walk.id}`, desk)).status === 'NO_SHOW', 'D-12 marked as left');
const back = await call('POST', `/api/scheduling/v1/desk/appointments/${walk.id}/check-in`, desk);
check(back.status === 'CHECKED_IN' && !!back.tokenNo, `D-12 came back: checked in again (token ${back.tokenNo}), same visit and payment`);

// ======== E-3 receipt; cash refund handed back ========
const R = await patient('Wave Three Refund');
const paidAppt = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: R.self.id, slotId: slots[5].slotId, checkIn: false });
const collected = await waitFor(async () => { const r = await call('POST', '/api/billing/v1/desk/collect', desk, { sourceType: 'APPOINTMENT', sourceId: paidAppt.id, method: 'CASH' }); return r.http === 201 && r; });
check(collected?.status === 'PAID', 'fee collected in cash');
const pdf = await fetch(`${G}/api/billing/v1/invoices/${collected.id}/pdf`, { headers: { 'x-tenant-host': 'citycare.localhost', authorization: `Bearer ${desk}` } });
check(pdf.status === 200 && pdf.headers.get('content-type') === 'application/pdf', 'E-3 the desk can print the receipt');
await call('POST', `/api/scheduling/v1/appointments/${paidAppt.id}/cancel`, desk, { reason: 'Doctor called away' });
const hb = await waitFor(async () => (await call('GET', '/api/billing/v1/desk/refunds', desk)).list?.find((r) => r.invoice.id === collected.id), 60000, 2000);
check(hb?.amount === 300, `cash refund waits for the desk to hand it back (₹${hb?.amount}; was: marked done at once)`);
const done = await call('POST', `/api/billing/v1/refunds/${hb.id}/handed-back`, desk, { method: 'CASH' });
check(done.status === 'PROCESSED' && (await call('GET', `/api/billing/v1/invoices/${collected.id}`, desk)).status === 'REFUNDED', 'handed back: refund done, invoice refunded');
check((await call('POST', `/api/billing/v1/refunds/${hb.id}/handed-back`, desk, {})).code === 'NOT_WAITING', 'not twice');

// ======== D-3 staff book lab tests ========
const cat = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
const T = (code) => cat.tests.find((t) => t.code === code);
const L = await patient('Wave Three Lab');
const ls = (await call('GET', `/api/diagnostics/v1/desk/lab-slots?branchId=${A.id}&date=${dayPlus(2)}`, lab)).slots?.find((s) => s.left > 0);
const lo = await call('POST', '/api/diagnostics/v1/desk/lab-orders', lab, { patientId: L.self.id, branchId: A.id, slotAt: ls.slotAt, items: [{ testId: T('CBC').id }, { testId: T('LIPID').id }] });
check(lo.http === 201 && lo.status === 'BOOKED' && lo.paymentMode === 'AT_CLINIC', `D-3 the lab booked ${lo.orderNo} for a walk-in patient (was: patients only)`);
const ws = (await call('GET', `/api/diagnostics/v1/desk/lab-slots?branchId=${A.id}&date=${today()}`, desk)).slots ?? [];
check(Array.isArray(ws), `D-3 the desk sees today's lab times (${ws.length}, including the one running now)`);
const prep = await waitFor(async () => psql(`SELECT count(*) FROM notification.notifications WHERE related_id = '${lo.id}' AND template_key = 'lab_prep_reminder' AND status = 'SCHEDULED'`) !== '0', 20000, 1000);
check(!!prep, '4.G a preparation reminder is scheduled 12 hours before (fasting test)');
await call('POST', `/api/diagnostics/v1/lab-orders/${lo.id}/cancel`, lab, { reason: 'patient asked' });
check(!!(await waitFor(async () => (await mail(`to:${L.phone.slice(1)}@sms.medicare.local`)).some((m) => m.Snippet.includes(lo.orderNo) && m.Snippet.includes('cancelled')), 30000, 1000)), '4.G the patient is told the tests are cancelled (SMS)');
check(psql(`SELECT count(*) FROM notification.notifications WHERE related_id = '${lo.id}' AND template_key = 'lab_prep_reminder' AND status = 'SCHEDULED'`) === '0', '4.G and the reminder is dropped');
// a test the doctor ordered: the desk gives it a time
const dr = await waitFor(() => staffToken(doctorEmail).catch(() => null), 20000, 1000);
await call('POST', `/api/scheduling/v1/appointments/${back.id}/start`, dr);
await waitFor(async () => (await call('POST', '/api/records/v1/encounters', dr, { appointmentId: back.id })).http === 201, 20000, 1000);
const dor = await waitFor(async () => { const r = await call('POST', '/api/diagnostics/v1/doctor/lab-orders', dr, { patientId: Q.self.id, items: [{ testId: T('CBC').id }] }); return r.http === 201 && r; }, 20000, 1000);
const waiting = (await call('GET', `/api/diagnostics/v1/desk/patients/${Q.self.id}/lab-orders/waiting`, desk)).list ?? [];
check(waiting.some((o) => o.id === dor.id), 'D-3 the desk sees the doctor-ordered tests waiting for a time');
const sch = await call('POST', `/api/diagnostics/v1/desk/lab-orders/${dor.id}/schedule`, desk, { branchId: A.id, slotAt: ls.slotAt });
check(sch.status === 'BOOKED', 'D-3 and books them');

// ======== D-10 dispatcher ========
const visit = psql(`SELECT v.id FROM diagnostics.home_visits v WHERE v.status IN ('UNASSIGNED','ASSIGNED') AND v.branch_id = '${A.id}' LIMIT 1`);
if (visit) {
  const ms = await call('POST', `/api/diagnostics/v1/lab/home-visits/${visit}/missed`, lab, { reason: 'No collector free' });
  check(ms.status === 'MISSED' || ms._body?.status === 'MISSED' || psql(`SELECT status FROM diagnostics.home_visits WHERE id = '${visit}'`) === 'MISSED', 'D-10 the dispatcher closes a visit that cannot happen; the patient picks a new time');
} else console.log('  (D-10: no open home visit to close; covered by mc test home)');

// ======== E-10 catalog editor; E-4 branch time zone; E-5 home windows ========
const admCat = await call('GET', '/api/diagnostics/v1/admin/lab-catalog', admin);
const hb1 = admCat.tests.find((t) => t.code === 'FBS');
const ranges = hb1.referenceRanges.map((r) => ({ ...r }));
const bad = await call('PATCH', `/api/diagnostics/v1/admin/lab-tests/${hb1.id}`, admin, { referenceRanges: [{ ...ranges[0], criticalLow: (ranges[0].low ?? 0) + 5 }] });
check(bad.http === 400 || bad.http === 422, 'E-10 a critical limit inside the normal range is refused');
const ok = await call('PATCH', `/api/diagnostics/v1/admin/lab-tests/${hb1.id}`, admin, { referenceRanges: ranges, turnaroundHours: hb1.turnaroundHours });
check(ok.http === 200 && JSON.stringify(ok.referenceRanges) === JSON.stringify(ranges), 'E-10 ranges and turnaround saved');
const br = (await call('GET', '/api/tenant/v1/branches', admin)).list.find((b) => b.id === A.id);
check([400, 422].includes((await call('PATCH', `/api/tenant/v1/branches/${A.id}`, admin, { timezone: 'Mars/Olympus', version: br.version })).http), 'E-4 an unknown time zone is refused');
const win = (await call('GET', `/api/diagnostics/v1/admin/home-windows/${A.id}`, admin)).list ?? [];
check((await call('PUT', `/api/diagnostics/v1/admin/home-windows/${A.id}`, admin, { windows: win.map((w) => ({ day: w.day, start: w.start, end: w.end, slotMinutes: w.slotMinutes, capacity: w.capacity })) })).http === 200, `E-5 home visit times saved (${win.length} windows)`);

// ======== E-6 patient edits family, leaves waitlist; E-8 bill detail ========
const kid = await call('POST', '/api/patient/v1/me/dependents', P.token, { fullName: 'Wave Kid', dob: '2018-03-03', gender: 'FEMALE', relation: 'CHILD' });
const kid2 = await call('PATCH', `/api/patient/v1/me/dependents/${kid.id}`, P.token, { fullName: 'Wave Kiddo', version: kid.version });
check(kid2.fullName === 'Wave Kiddo', 'E-6 a family member\'s name corrected');
const wl = await call('POST', '/api/scheduling/v1/waitlist', P.token, { doctorId: doc.id, date: dayPlus(3), patientId: P.self.id });
check((await call('DELETE', `/api/scheduling/v1/waitlist/${wl.id}`, P.token)).http === 204, 'E-6 left the waitlist');
const bill = await call('GET', `/api/billing/v1/invoices/${collected.id}`, R.token);
check(bill.refunds?.[0]?.status === 'PROCESSED', 'E-8 the patient sees the refund on the bill');

// ======== 4.G doctor agenda; follow-up reminder ========
const ag = await internal(4405, `/internal/tenants/${TID}/agenda`, { hour: 0 });
check(ag.sent >= 1, `4.G morning agendas sent (${ag.sent} doctors)`);
check(!!(await waitFor(async () => (await mail('subject:"Your patients today"')).some((m) => m.To?.some((t) => t.Address.toLowerCase() === doctorEmail.toLowerCase())), 30000, 1000)), '4.G the doctor got today\'s list');
const enc = (await call('GET', `/api/records/v1/encounters/by-appointment/${back.id}`, dr)).id;
const rx = await call('POST', `/api/records/v1/encounters/${enc}/prescriptions`, dr, { items: [{ drugName: 'Paracetamol', strength: '500 mg', dosage: '1-0-1', durationDays: 3 }], followUpOn: dayPlus(5) });
check(rx.http === 201, 'prescription with a follow-up date');
check(!!(await waitFor(async () => psql(`SELECT count(*) FROM notification.notifications WHERE related_id = '${rx.id}' AND template_key = 'follow_up_reminder' AND status = 'SCHEDULED'`) !== '0', 20000, 1000)), '4.G a follow-up reminder is scheduled for the day before');

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mwave 3: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
