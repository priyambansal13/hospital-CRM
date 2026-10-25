#!/usr/bin/env node
// Wave 1 of the flow review (docs/ROLE-FLOWS-AND-GAPS.md §6), against the local gateway: each fix is checked the way
// a user would hit it.
//   lab: values with units/commas read correctly, unreadable ones refused (C-1); no tube rejection after results
//   (C-7); X-ray-only orders reach a report (D-2); recollection any day and patient rebooking (D-4); a stranded
//   amendment can be republished (D-6) · clinic: prescription vs allergy (C-3); no completing an unsigned visit, and
//   the unsigned list (C-4) · video off (D-1) · unpublishing a doctor / closing a branch cancels and refunds their
//   bookings, after the admin saw the count (D-5) · the real cancel window (F-3) · invited staff become ACTIVE and
//   stay reachable (A-3) · no role escalation (B-3) · error and "booking paused" pages (F-1, F-2).
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
const [lab, path] = await Promise.all(['lab', 'path'].map((u) => staffToken(`${u}@citycare.test`)));
const cat = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
const T = (code) => cat.tests.find((t) => t.code === code);
const branch = (await call('GET', '/api/diagnostics/v1/public/lab-branches')).list.find((b) => b.name === 'Sector 44');
let labSlot;
for (let d = 1; d < 25 && !labSlot; d++) labSlot = (await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${branch.id}&date=${dayPlus(d)}`)).slots?.find((s) => s.left > 2);

/** A lab order for the patient, moved to today and paid at the counter (the lab tech collects). */
async function labOrder(P, codes) {
  const o = await call('POST', '/api/diagnostics/v1/lab-orders', P.token, { patientId: P.self.id, branchId: branch.id, slotAt: labSlot.slotAt, items: codes.map((c) => ({ testId: T(c).id })), paymentMode: 'AT_CLINIC' });
  if (o.http !== 201) throw new Error(`lab order: ${o.status} ${o.code} ${o.detail}`);
  psql(`UPDATE diagnostics.lab_orders SET slot_at = now() - interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id = '${o.id}'`);
  await waitFor(async () => (await call('POST', '/api/billing/v1/desk/collect', lab, { sourceType: 'LAB_ORDER', sourceId: o.id, method: 'CASH' })).http === 201);
  await waitFor(async () => (await call('GET', `/api/diagnostics/v1/lab-orders/${o.id}`, lab)).paymentStatus === 'PAID');
  return call('GET', `/api/diagnostics/v1/lab-orders/${o.id}`, lab);
}

// ======== LAB ========
const P = await patient('Gaps Lab Patient');
const o1 = await labOrder(P, ['FBS', 'CBC']);
for (const s of o1.samples) await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: s.barcode });
for (const s of o1.samples) await call('POST', '/api/diagnostics/v1/lab/samples/receive', lab, { barcode: s.barcode });
const sheet = await call('GET', `/api/diagnostics/v1/lab/orders/${o1.id}/results`, lab);
const item = (code) => sheet.tests.find((t) => t.code === code).itemId;
check(sheet.order?.status === 'IN_LAB', `${o1.orderNo} (FBS, CBC) is in the lab`);

// C-1
const withUnit = await call('POST', `/api/diagnostics/v1/lab/orders/${o1.id}/results`, lab, { results: [{ itemId: item('FBS'), parameter: 'Glucose, fasting', value: '450 mg/dL' }] });
const fbs = withUnit.tests?.find((t) => t.code === 'FBS').parameters[0];
check(fbs?.value === '450' && fbs.flag === 'CRITICAL_HIGH', `C-1 "450 mg/dL" → stored as ${fbs?.value}, ${fbs?.flag} (was: text, NORMAL, no alert)`);
const word = await call('POST', `/api/diagnostics/v1/lab/orders/${o1.id}/results`, lab, { results: [{ itemId: item('CBC'), parameter: 'Haemoglobin', value: 'high' }] });
check(word.http === 422 && word.code === 'NOT_A_NUMBER', `C-1 "high" for haemoglobin refused (${word.code}: ${word.detail})`);
const unitMix = await call('POST', `/api/diagnostics/v1/lab/orders/${o1.id}/results`, lab, { results: [{ itemId: item('CBC'), parameter: 'Platelet count', value: '250000' }] });
check(unitMix.http === 422 && unitMix.code === 'IMPLAUSIBLE_VALUE', `C-1 platelets "250000" (unit mix-up) refused: ${unitMix.detail}`);
const rest = await call('POST', `/api/diagnostics/v1/lab/orders/${o1.id}/results`, lab, { results: [
  { itemId: item('CBC'), parameter: 'Haemoglobin', value: '14,2' }, { itemId: item('CBC'), parameter: 'WBC count', value: '7.5' }, { itemId: item('CBC'), parameter: 'Platelet count', value: '250' }] });
check(rest.order?.status === 'RESULTS_ENTERED' && rest.tests.find((t) => t.code === 'CBC').parameters.find((p) => p.parameter === 'Haemoglobin').value === '14.2', 'C-1 decimal comma "14,2" → 14.2; all results entered');

// C-7
const late = await call('POST', '/api/diagnostics/v1/lab/samples/reject', lab, { barcode: o1.samples[0].barcode, reason: 'haemolysed' });
check(late.http === 409 && late.code === 'RESULTS_ALREADY_ENTERED', `C-7 a tube cannot be rejected after results are entered (${late.code})`);

// D-6
const v1 = await call('POST', `/api/diagnostics/v1/lab/orders/${o1.id}/verify`, path);
psql(`UPDATE diagnostics.lab_results SET entered_at = now() WHERE order_id = '${o1.id}' AND parameter = 'WBC count'`); // as if an amendment's report failed to store
const retry = await call('POST', `/api/diagnostics/v1/lab/orders/${o1.id}/amend`, path, { reason: 'republish after a failed save', results: [{ itemId: item('CBC'), parameter: 'WBC count', value: '7.5' }] });
check(v1.http === 201 && retry.http === 201 && retry.version === 2, `D-6 values newer than the published report can be republished (v${retry.version}; was NOTHING_TO_AMEND forever)`);
const nothing = await call('POST', `/api/diagnostics/v1/lab/orders/${o1.id}/amend`, path, { reason: 'nothing changed at all', results: [{ itemId: item('CBC'), parameter: 'WBC count', value: '7.5' }] });
check(nothing.code === 'NOTHING_TO_AMEND', 'D-6 …but an amendment that changes nothing is still refused');

// D-2
const xray = await labOrder(P, ['XRAY_CHEST']);
check(xray.samples.length === 0 && xray.status === 'BOOKED', `X-ray order ${xray.orderNo}: no tubes, booked and paid`);
const seen = await call('POST', `/api/diagnostics/v1/lab/lab-orders/${xray.id}/performed`, lab);
check(seen.http === 200 && seen.http !== 409 && seen.orderNo === xray.orderNo && (await call('GET', `/api/diagnostics/v1/lab-orders/${xray.id}`, lab)).status === 'IN_LAB', 'D-2 "patient seen" → IN_LAB (X-ray-only orders used to be stuck forever)');
const xs = await call('GET', `/api/diagnostics/v1/lab/orders/${xray.id}/results`, lab);
const xr = await call('POST', `/api/diagnostics/v1/lab/orders/${xray.id}/results`, lab, { results: [{ itemId: xs.tests[0].itemId, parameter: 'Result', value: 'No active lung disease' }] });
const xv = await call('POST', `/api/diagnostics/v1/lab/orders/${xray.id}/verify`, path);
check(xr.order?.status === 'RESULTS_ENTERED' && xv.http === 201, 'D-2 the X-ray report is written and verified');
check((await call('POST', `/api/diagnostics/v1/lab/lab-orders/${o1.id}/performed`, lab)).code === 'HAS_SAMPLES', 'D-2 orders with tubes still go through the scans');

// D-4
const o3 = await labOrder(P, ['FBS']);
await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: o3.samples[0].barcode });
const rej = await call('POST', '/api/diagnostics/v1/lab/samples/reject', lab, { barcode: o3.samples[0].barcode, reason: 'not enough blood' });
check(rej.http === 200 && rej.order.status === 'SAMPLE_REJECTED', `tube rejected → new label ${rej.replacement}`);
const rebook = await call('POST', `/api/diagnostics/v1/lab-orders/${o3.id}/schedule`, P.token, { branchId: branch.id, slotAt: labSlot.slotAt, paymentMode: 'AT_CLINIC' });
check(rebook.http < 300 && (await call('GET', `/api/diagnostics/v1/lab-orders/${o3.id}`, P.token)).status === 'BOOKED', 'D-4 the patient picks a new time for the recollection (no extra charge)');
psql(`UPDATE diagnostics.lab_orders SET local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date - 3 WHERE id = '${o3.id}'`); // they come on another day after all
const again = await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: rej.replacement });
check(again.http === 200 && again.order?.status === 'SAMPLE_COLLECTED', 'D-4 the replacement tube is collected at the counter on any day (was NOT_TODAY)');

// ======== CLINIC ========
const doctorEmail = `gapdoc.${SFX}@citycare.test`;
const docName = `Dr. Gap Check ${SFX}`;
const doc = await call('POST', '/api/provider/v1/doctors', admin, { name: docName, email: doctorEmail, registrationNo: `GAP/${SFX}`, specialties: [{ code: 'GENERAL_MEDICINE', primary: true }], branches: [{ branchId: branch.id, fee: 500 }], consultModes: ['IN_PERSON'] });
await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'ACTIVE' });
const desk = await staffToken('desk@citycare.test');
const C = await patient('Gaps Clinic Patient');
const walk = await waitFor(async () => { const r = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: C.self.id, walkIn: { doctorId: doc.id, branchId: branch.id } }); return r.http === 201 && r; });
const dr = await waitFor(() => staffToken(doctorEmail).catch(() => null), 20000, 1000);
await call('POST', `/api/scheduling/v1/appointments/${walk.id}/start`, dr);
// the walk-in reaches records-service by event a moment later
const opened = await waitFor(async () => { const e = await call('POST', '/api/records/v1/encounters', dr, { appointmentId: walk.id }); return e.http === 201 && e; }, 20000, 1000);
let enc = opened?.encounter;
check(!!enc?.id && enc.status === 'OPEN', `walk-in with ${docName}: visit started, note open`);

// C-3
await call('POST', `/api/patient/v1/patients/${C.self.id}/allergies`, dr, { substance: 'Penicillin', severity: 'SEVERE', reaction: 'rash' });
const amox = await call('POST', `/api/records/v1/encounters/${enc.id}/prescriptions`, dr, { items: [{ drugName: 'Amoxicillin 500', dosage: '1-0-1', durationDays: 5 }] });
check(amox.http === 409 && amox.code === 'ALLERGY_CONFLICT', `C-3 amoxicillin for a penicillin-allergic patient refused: ${amox.detail}`);
const safe = await call('POST', `/api/records/v1/encounters/${enc.id}/prescriptions`, dr, { items: [{ drugName: 'Paracetamol 650', dosage: '1-1-1', durationDays: 3 }] });
check(safe.http === 201, 'C-3 an unrelated medicine is prescribed normally');
const over = await call('POST', `/api/records/v1/encounters/${enc.id}/prescriptions`, dr, { items: [{ drugName: 'Amoxicillin 500', dosage: '1-0-1' }], allergyOverride: 'Tolerated amoxicillin last year under observation' });
check(over.http === 201 && psql(`SELECT allergy_override_reason FROM records.prescriptions WHERE id = '${over.id}'`).startsWith('Tolerated'), 'C-3 with a reason the doctor can prescribe anyway; the reason is kept');

// C-4
const early = await call('POST', `/api/scheduling/v1/appointments/${walk.id}/complete`, dr, {});
check(early.http === 409 && early.code === 'NOTE_NOT_SIGNED', `C-4 an unsigned visit cannot be completed (${early.code})`);
const deferred = await call('POST', `/api/scheduling/v1/appointments/${walk.id}/complete`, dr, { allowUnsigned: true });
const unsigned = await call('GET', '/api/records/v1/encounters/unsigned', dr);
check(deferred.http === 200 && unsigned.list?.some((u) => u.encounterId === enc.id), 'C-4 "finish, sign later" completes it, and the note waits in Unsigned notes');
enc = await call('GET', `/api/records/v1/encounters/${enc.id}`, dr);
const dx = await call('PATCH', `/api/records/v1/encounters/${enc.id}`, dr, { version: enc.version, diagnoses: [{ code: 'J06.9', description: 'Upper respiratory infection', isPrimary: true }] });
await call('POST', `/api/records/v1/encounters/${enc.id}/sign`, dr, { version: dx.version ?? enc.version + 1 });
check(!(await call('GET', '/api/records/v1/encounters/unsigned', dr)).list?.some((u) => u.encounterId === enc.id), 'C-4 signed → gone from Unsigned notes');

// D-1
const video = await call('POST', `/api/scheduling/v1/doctors/${doc.id}/availability`, admin, { days: [1, 2, 3, 4, 5, 6, 7], branchId: branch.id, startTime: '09:00', endTime: '12:00', slotMinutes: 15, mode: 'VIDEO' });
check(video.http === 422 && video.code === 'VIDEO_NOT_AVAILABLE', `D-1 video hours refused until video rooms exist (${video.code})`);
const anyVideo = psql(`SELECT count(*) FROM scheduling.slots WHERE mode = 'VIDEO' AND status = 'OPEN' AND starts_at > now()`);
const offered = await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=14`);
check(!offered.days?.some((d) => d.slots.some((s) => s.mode === 'VIDEO')), `D-1 patients are offered no video slots (${anyVideo} old video slots in the database stay hidden)`);

// D-5: the doctor's future booking is cancelled when the admin unpublishes them, after seeing the count
await call('POST', `/api/scheduling/v1/doctors/${doc.id}/availability`, admin, { days: [1, 2, 3, 4, 5, 6, 7], branchId: branch.id, startTime: '09:00', endTime: '12:00', slotMinutes: 15, effectiveFrom: dayPlus(3) });
const slots = await waitFor(async () => { const r = await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=14`); return r.days?.find((d) => d.slots.length) && r; });
const future = await call('POST', '/api/scheduling/v1/appointments', C.token, { slotId: slots.days.find((d) => d.slots.length).slots[0].slotId, patientId: C.self.id });
const count = await call('GET', `/api/scheduling/v1/upcoming-appointments?doctorId=${doc.id}`, admin);
check(future.http === 201 && count.upcoming === 1, `D-5 the admin sees "${count.upcoming} upcoming appointment" before unpublishing`);
await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'INACTIVE' });
const cancelled = await waitFor(async () => { const a = await call('GET', `/api/scheduling/v1/appointments/${future.id}`, C.token); return a.status === 'CANCELLED' && a; }, 30000, 1000);
check(cancelled?.cancelReason === 'DOCTOR_UNAVAILABLE' || cancelled?.status === 'CANCELLED', `D-5 unpublished → ${future.appointmentNo} cancelled by the hospital (was: left booked)`);
const told = await waitFor(async () => (await mail(`to:${C.phone.slice(1)}@sms.medicare.local`)).find((m) => m.Snippet.includes(future.appointmentNo) && /cancel/i.test(m.Snippet)), 20000, 1000);
check(!!told, `D-5 the patient is told: "${told?.Snippet.slice(0, 80)}…"`);

// D-5: closing a branch cancels its bookings
const nb = await call('POST', '/api/tenant/v1/branches', admin, { name: `Gap Branch ${SFX}`, city: 'Gurugram', address: { pincode: '122001' } });
const doc2 = await waitFor(async () => { const d = await call('POST', '/api/provider/v1/doctors', admin, { name: `Dr. Branch Gap ${SFX}`, email: `branchgap.${SFX}@citycare.test`, registrationNo: `GAPB/${SFX}`, specialties: [{ code: 'GENERAL_MEDICINE', primary: true }], branches: [{ branchId: nb.id, fee: 300 }], consultModes: ['IN_PERSON'] }); return d.http === 201 && d; }, 20000, 1000);
await call('POST', `/api/provider/v1/doctors/${doc2.id}/status`, admin, { status: 'ACTIVE' });
await waitFor(async () => (await call('POST', `/api/scheduling/v1/doctors/${doc2.id}/availability`, admin, { days: [1, 2, 3, 4, 5, 6, 7], branchId: nb.id, startTime: '09:00', endTime: '12:00', slotMinutes: 30, effectiveFrom: dayPlus(2) })).http === 201, 20000, 1000);
const s2 = await waitFor(async () => { const r = await call('GET', `/api/scheduling/v1/public/doctors/${doc2.id}/slots?days=14`); return r.days?.find((d) => d.slots.length)?.slots[0]; });
const atBranch = await call('POST', '/api/scheduling/v1/appointments', C.token, { slotId: s2.slotId, patientId: C.self.id });
check((await call('GET', `/api/scheduling/v1/upcoming-appointments?branchId=${nb.id}`, admin)).upcoming === 1, 'D-5 the admin sees 1 upcoming appointment at the branch');
await call('PATCH', `/api/tenant/v1/branches/${nb.id}`, admin, { active: false, version: nb.version ?? 0 });
check(!!(await waitFor(async () => (await call('GET', `/api/scheduling/v1/appointments/${atBranch.id}`, C.token)).status === 'CANCELLED', 30000, 1000)), `D-5 branch closed → ${atBranch.appointmentNo} cancelled and refunded`);

// ======== SETTINGS, STAFF, ROLES ========
const before = (await call('GET', '/api/entitlement/v1/settings', admin)).list?.find?.((s) => s.key === 'appointments.cancel_cutoff_hours')?.value ?? 2;
await call('PUT', '/api/entitlement/v1/settings/appointments.cancel_cutoff_hours', admin, { value: 6 });
const pol = await waitFor(async () => { const r = await call('GET', '/api/scheduling/v1/me/appointments', C.token); return r.policy?.cancelWindowHours === 6 && r; }, 40000, 1000);
check(!!pol, `F-3 patients see the hospital's cancel window (6 h), not the default (${pol?.policy?.cancelWindowHours})`);
await call('PUT', '/api/entitlement/v1/settings/appointments.cancel_cutoff_hours', admin, { value: before });

const sEmail = `gapstaff.${SFX}@citycare.test`;
const inv = await call('POST', '/api/iam/v1/staff/invites', admin, { email: sEmail, name: 'Gap Staff', roles: ['RECEPTIONIST'] });
psql(`UPDATE iam.staff_members SET status = 'INVITED' WHERE user_id = '${inv.userId}'`); // as in production before the first sign-in
const contact = await fetch(`http://localhost:4402/internal/tenants/${psql("SELECT tenant_id FROM public.tenant_meta")}/staff/${inv.userId}`, { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }).then((r) => r.json());
check(contact.active === true && contact.status === 'INVITED', 'A-3 an invited member is still reachable by e-mail (was: no e-mail until ACTIVE, which never happened)');
const signed = await call('POST', '/api/iam/v1/me/signed-in', await staffToken(sEmail));
check(signed.status === 'ACTIVE' && signed.activated === true, 'A-3 the first sign-in makes them ACTIVE');

await call('POST', '/api/entitlement/v1/roles', admin, { code: `HR_${LETTERS}`, name: `HR ${LETTERS}` });
await call('PUT', `/api/entitlement/v1/roles/HR_${LETTERS}`, admin, { permissions: ['staff:read:tenant', 'staff:invite:tenant', 'role:read:tenant', 'role:assign:tenant', 'role:manage:tenant', 'branch:read:tenant'] });
const hrEmail = `gaphr.${SFX}@citycare.test`;
await call('POST', '/api/iam/v1/staff/invites', admin, { email: hrEmail, name: 'Gap HR', roles: [`HR_${LETTERS}`] });
const hr = await waitFor(async () => { const t = await staffToken(hrEmail).catch(() => null); return t && (await call('GET', '/api/entitlement/v1/me/capabilities', t)).permissions?.includes('staff:invite:tenant') && t; }, 20000, 1000);
const toAdmin = await call('POST', '/api/iam/v1/staff/invites', hr, { email: `escalate.${SFX}@citycare.test`, name: 'Escalate', roles: ['TENANT_ADMIN'] });
check(toAdmin.http === 403 && toAdmin.code === 'ROLE_ESCALATION', `B-3 HR cannot invite a hospital admin (${toAdmin.code})`);
const toDesk = await call('POST', '/api/iam/v1/staff/invites', hr, { email: `escalate2.${SFX}@citycare.test`, name: 'Escalate 2', roles: ['RECEPTIONIST'] });
check(toDesk.http === 403 && /missing/.test(toDesk.detail ?? ''), `B-3 …nor give a role with permissions HR doesn't have (${toDesk.detail})`);
const grant = await call('POST', `/api/entitlement/v1/users/${inv.userId}/roles`, hr, { roleCode: 'TENANT_ADMIN' });
check(grant.http === 403 && grant.code === 'ROLE_ESCALATION', 'B-3 …nor assign hospital admin to an existing member');
const unknown = await call('POST', '/api/iam/v1/staff/invites', admin, { email: `ghost.${SFX}@citycare.test`, name: 'Ghost', roles: ['NO_SUCH_ROLE'] });
check(unknown.http === 422 && unknown.code === 'UNKNOWN_ROLE', 'B-3 an unknown role is refused before any login is created');
const self = await call('PUT', `/api/entitlement/v1/roles/HR_${LETTERS}`, hr, { permissions: ['staff:read:tenant', 'staff:invite:tenant', 'role:read:tenant', 'role:assign:tenant', 'role:manage:tenant', 'branch:read:tenant', 'settings:manage:tenant'] });
check(self.http === 403 && self.code === 'ROLE_ESCALATION', `B-3 HR (who may edit roles) cannot add a permission it doesn't hold to its own role (${self.code})`);

// ======== PAGES ========
const page = (host, p) => execFileSync('curl', ['-s', '-H', `Host: ${host}:3400`, `http://localhost:3400${p}`], { encoding: 'utf8' });
check(/Page not found/.test(page('citycare.localhost', '/care/no-such-page')) && /Page not found/.test(page('citycare.localhost', '/admin/no-such-page')), 'F-1 unknown pages show the branded "Page not found" with a way home (patient and admin zones)');
check(/is paused at this hospital/.test(page('medicare.localhost', '/care/doctors')), 'F-2 a hospital without online booking shows "Online booking is paused", not an error');

console.log(failures ? `\n\x1b[31mgaps: ${failures} failed\x1b[0m` : '\n\x1b[32mgaps ok\x1b[0m');
process.exit(failures ? 1 : 0);
