#!/usr/bin/env node
// Wave 2 of the flow review (docs/ROLE-FLOWS-AND-GAPS.md §6): access control and staff lifecycle, against the local
// gateway. Branch scoping (B-1) · trimmed and split permissions (B-4) · nurse triage · critical values escalate and
// are phoned through with a read-back (C-2) · desk alerts for chat requests · offboarding, resend, reset (B-2) · admin
// actions in the audit log (B-8).
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
const branches = (await call('GET', '/api/tenant/v1/branches', admin)).list;
const A = branches.find((b) => b.name === 'Sector 44');
const B = branches.find((b) => b.name === 'Pin Test' && b.active);
check(!!A && !!B, `two branches: ${A?.name}, ${B?.name}`);

/** A new staff member (dev: signs in at once with the dev password) with one role, at one branch or everywhere. */
async function newStaff(tag, role, branchId = null) {
  const email = `${tag}.${SFX}@example.test`;
  const inv = await call('POST', '/api/iam/v1/staff/invites', admin, { email, name: `${tag} ${SFX}`, roles: [role], branchId });
  if (inv.http !== 201) throw new Error(`invite ${email}: ${inv.code} ${inv.detail}`);
  // the roles arrive by event
  await waitFor(async () => (await call('GET', `/api/entitlement/v1/users/${inv.userId}/roles`, admin)).list?.length > 0);
  return { ...inv, email, token: await waitFor(() => staffToken(email).catch(() => null), 20000, 1000) };
}

// ======== B-1 branch scoping ========
const rcp = await newStaff('rcpb', 'RECEPTIONIST', B.id);
const rcaps = await call('GET', '/api/entitlement/v1/me/capabilities', rcp.token);
check(JSON.stringify(rcaps.branchScopes?.['appointment:checkin:branch']) === JSON.stringify([B.id]) && JSON.stringify(rcaps.branchIds) === JSON.stringify([B.id]), `B-1 receptionist given the role at ${B.name}: capabilities say so`);
check((await call('GET', `/api/scheduling/v1/desk/board?branchId=${A.id}`, rcp.token)).code === 'OUTSIDE_BRANCH', `B-1 ${A.name}'s desk board refused (403 OUTSIDE_BRANCH)`);
check((await call('GET', `/api/scheduling/v1/desk/board?branchId=${B.id}`, rcp.token)).http === 200, `B-1 ${B.name}'s board is fine`);
const apptA = psql(`SELECT id FROM scheduling.appointments WHERE branch_id = '${A.id}' ORDER BY created_at DESC LIMIT 1`);
const apptB = psql(`SELECT id FROM scheduling.appointments WHERE branch_id = '${B.id}' ORDER BY created_at DESC LIMIT 1`);
check((await call('GET', `/api/scheduling/v1/appointments/${apptA}`, rcp.token)).http === 404 && (await call('GET', `/api/scheduling/v1/appointments/${apptB}`, rcp.token)).http === 200, 'B-1 an appointment at the other branch is not found; one at their own is');
const invA = psql(`SELECT id FROM billing.invoices WHERE branch_id = '${A.id}' ORDER BY issued_at DESC LIMIT 1`);
check((await call('GET', `/api/billing/v1/invoices/${invA}`, rcp.token)).http === 404, 'B-1 an invoice of the other branch is not found');
const day = (await call('GET', '/api/billing/v1/invoices', rcp.token));
check(day.http === 200 && day.items.every((i) => i.branch?.id ? i.branch.id === B.id : true) && (await call('GET', `/api/billing/v1/invoices?branchId=${A.id}`, rcp.token)).code === 'OUTSIDE_BRANCH', 'B-1 the billing desk lists their branch only; asking for the other is refused');
check((await call('GET', `/api/scheduling/v1/desk/board?branchId=${A.id}`, desk)).http === 200, 'B-1 a hospital-wide receptionist still sees every branch');
const labB = await newStaff('labb', 'LAB_TECH', B.id);
const anyOrder = psql(`SELECT id FROM diagnostics.lab_orders WHERE branch_id = '${A.id}' ORDER BY created_at DESC LIMIT 1`);
check((await call('GET', `/api/diagnostics/v1/lab/worklist?branchId=${A.id}`, labB.token)).code === 'OUTSIDE_BRANCH' && (await call('GET', `/api/diagnostics/v1/lab-orders/${anyOrder}`, labB.token)).http === 404, `B-1 a lab tech at ${B.name} cannot open ${A.name}'s worklist or orders`);

// ======== B-4 split permissions, trimmed defaults ========
const roles = (await call('GET', '/api/entitlement/v1/roles', admin)).list;
const ba = roles.find((r) => r.code === 'BRANCH_ADMIN')?.permissions ?? [];
check(!ba.includes('doctor:manage:tenant') && !ba.includes('lab_catalog:manage:tenant') && !ba.includes('audit:read:tenant') && !ba.includes('home_area:manage:tenant') && ba.includes('critical:escalation:branch'), 'B-4 branch admin no longer edits doctors, lab prices, home areas or reads the hospital audit log');
const rc = roles.find((r) => r.code === 'RECEPTIONIST')?.permissions ?? [];
check(!rc.includes('report:read:branch') && !rc.includes('lab_order:cancel:branch'), 'B-4 receptionist: no lab report PDFs, no cancelling lab orders');
const pub = psql(`SELECT id FROM diagnostics.lab_orders WHERE status = 'REPORT_PUBLISHED' AND branch_id = '${A.id}' ORDER BY created_at DESC LIMIT 1`);
check((await call('GET', `/api/diagnostics/v1/lab/orders/${pub}/report.pdf`, desk)).code === 'PERMISSION_DENIED', 'B-4 the desk cannot open report PDFs');
check(roles.find((r) => r.code === 'NURSE')?.permissions.includes('vitals:record:branch'), 'nurses record vitals');

// ======== Nurse triage, and the desk cannot run the doctor's visit (B-4) ========
const doctorEmail = `w2doc.${SFX}@citycare.test`;
const doc = await call('POST', '/api/provider/v1/doctors', admin, { name: `Dr. Wave Two ${SFX}`, email: doctorEmail, registrationNo: `W2/${SFX}`, specialties: [{ code: 'GENERAL_MEDICINE', primary: true }], branches: [{ branchId: A.id, fee: 400 }], consultModes: ['IN_PERSON'] });
await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'ACTIVE' });
const N = await patient('Wave Two Patient');
const walk = await waitFor(async () => { const r = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: N.self.id, walkIn: { doctorId: doc.id, branchId: A.id } }); return r.http === 201 && r; });
check(walk?.status === 'CHECKED_IN', `walk-in checked in (${walk?.appointmentNo})`);
const nurseB = await newStaff('nurseb', 'NURSE', B.id);
const nurse = await newStaff('nurse', 'NURSE', A.id);
const vitals = { bp: '150/95', pulse: 104, tempC: 38.4, spo2: 95 };
check((await call('PUT', `/api/records/v1/appointments/${walk.id}/triage`, nurseB.token, { vitals, priority: 'URGENT' })).http === 404, 'a nurse at the other branch cannot triage this patient');
const tri = await waitFor(async () => { const r = await call('PUT', `/api/records/v1/appointments/${walk.id}/triage`, nurse.token, { vitals, priority: 'URGENT', chiefComplaint: 'Fever for three days' }); return r.http === 200 && r; }, 20000, 1000);
check(tri?.priority === 'URGENT' && tri.vitals.pulse === 104 && tri.chiefComplaint === 'Fever for three days', 'nurse recorded vitals, URGENT, and the complaint');
const dr = await waitFor(() => staffToken(doctorEmail).catch(() => null), 20000, 1000);
const sum = await call('GET', `/api/records/v1/triage-summary?appointmentIds=${walk.id}`, dr);
check(sum[walk.id]?.priority === 'URGENT', 'the doctor\'s queue shows the priority');
const dstart = await call('POST', `/api/scheduling/v1/appointments/${walk.id}/start`, desk);
check(dstart.http === 403 && /only the doctor/.test(dstart.detail ?? ''), 'B-4 the desk cannot start the doctor\'s visit (was: DOCTOR_BUSY for the doctor)');
await call('POST', `/api/scheduling/v1/appointments/${walk.id}/start`, dr);
const enc = await waitFor(async () => { const e = await call('POST', '/api/records/v1/encounters', dr, { appointmentId: walk.id }); return e.http === 201 && e.encounter; }, 20000, 1000);
check(enc?.vitals?.bp === '150/95' && enc.chiefComplaint === 'Fever for three days', 'the visit note starts with the nurse\'s vitals and complaint');
check((await call('PUT', `/api/records/v1/appointments/${walk.id}/triage`, nurse.token, { vitals, priority: 'ROUTINE' })).code === 'INVALID_STATE_TRANSITION', 'once the doctor has started, triage is closed (vitals go in the note)');

// ======== C-2 critical values escalate ========
const lt = await staffToken('lab@citycare.test');
const cat = await call('GET', '/api/diagnostics/v1/public/lab-catalog');
let slot;
for (let d = 1; d < 25 && !slot; d++) slot = (await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${A.id}&date=${dayPlus(d)}`)).slots?.find((s) => s.left > 2);
const LP = await patient('Wave Two Critical');
const o = await call('POST', '/api/diagnostics/v1/lab-orders', LP.token, { patientId: LP.self.id, branchId: A.id, slotAt: slot.slotAt, items: [{ testId: cat.tests.find((t) => t.code === 'FBS').id }], paymentMode: 'AT_CLINIC' });
psql(`UPDATE diagnostics.lab_orders SET slot_at = now() - interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id = '${o.id}'`);
await waitFor(async () => (await call('POST', '/api/billing/v1/desk/collect', lt, { sourceType: 'LAB_ORDER', sourceId: o.id, method: 'CASH' })).http === 201);
await waitFor(async () => (await call('GET', `/api/diagnostics/v1/lab-orders/${o.id}`, lt)).paymentStatus === 'PAID');
const ord = await call('GET', `/api/diagnostics/v1/lab-orders/${o.id}`, lt);
for (const s of ord.samples) { await call('POST', '/api/diagnostics/v1/lab/samples/collect', lt, { barcode: s.barcode }); await call('POST', '/api/diagnostics/v1/lab/samples/receive', lt, { barcode: s.barcode }); }
const sh = await call('GET', `/api/diagnostics/v1/lab/orders/${o.id}/results`, lt);
await call('POST', `/api/diagnostics/v1/lab/orders/${o.id}/results`, lt, { results: [{ itemId: sh.tests[0].itemId, parameter: sh.tests[0].parameters[0].parameter, value: '480' }] });
const alertId = psql(`SELECT id FROM diagnostics.critical_alerts WHERE order_id = '${o.id}'`);
check(!!alertId && psql(`SELECT level || ':' || (escalate_at <= now()) FROM diagnostics.critical_alerts WHERE id = '${alertId}'`) === '0:true', 'C-2 a self-booked critical value is due for the pathologists at once (was: nobody told)');
const sw1 = await internal(4412, `/internal/tenants/${TID}/lab/critical-escalation`, {});
check(sw1.escalated >= 1 && psql(`SELECT level FROM diagnostics.critical_alerts WHERE id = '${alertId}'`) === '1', 'C-2 escalated to level 1 (pathologists)');
const m1 = await waitFor(async () => (await mail(`to:path@citycare.test subject:ESCALATED`)).find((m) => m.Snippet.includes(LP.self.mrn ?? 'Wave Two Critical') || m.Subject.includes('Wave Two Critical')), 30000, 1000);
check(!!m1, 'C-2 the pathologist got the ESCALATED e-mail');
const path = await staffToken('path@citycare.test');
const out = (await call('GET', '/api/diagnostics/v1/lab/critical-alerts', path)).list.find((a) => a.id === alertId);
check(out?.level === 1 && out.communicated === null, 'C-2 the lab\'s critical list shows it as escalated');
await internal(4412, `/internal/tenants/${TID}/lab/critical-escalation`, { dueNow: true });
check(psql(`SELECT level FROM diagnostics.critical_alerts WHERE id = '${alertId}'`) === '2', 'C-2 still nobody: level 2 (on call at the branch)');
const m2 = await waitFor(async () => (await mail('to:admin@citycare.test subject:ESCALATED')).find((m) => m.Subject.includes('Wave Two Critical')), 30000, 1000);
check(!!m2, 'C-2 on call (the hospital admin here) got the e-mail');
check((await call('POST', `/api/diagnostics/v1/lab/critical-alerts/${alertId}/communicated`, path, { communicatedTo: 'Dr. Duty', readBack: false })).code === 'READ_BACK_REQUIRED', 'C-2 recording needs the read-back');
const comm = await call('POST', `/api/diagnostics/v1/lab/critical-alerts/${alertId}/communicated`, path, { communicatedTo: 'Dr. Duty (casualty)', readBack: true });
check(comm.communicated === true && (await call('GET', '/api/diagnostics/v1/lab/critical-alerts', path)).list.find((a) => a.id === alertId)?.communicated?.to === 'Dr. Duty (casualty)', 'C-2 phoned through to Dr. Duty, read back: recorded');
const pathB = await newStaff('pathb', 'PATHOLOGIST', B.id);
check(!(await call('GET', '/api/diagnostics/v1/lab/critical-alerts', pathB.token)).list?.some((a) => a.id === alertId), 'B-1 a pathologist at the other branch does not see it');

// ======== Desk alerts for chat requests ========
const cp = await patient('Wave Two Chat');
const cid = (await call('POST', '/api/assistant/v1/assistant/messages', cp.token, { text: 'What are the visiting hours?' })).conversationId;
const before = await call('GET', '/api/assistant/v1/assistant/handoffs/summary', desk);
await call('POST', `/api/assistant/v1/assistant/conversations/${cid}/handoff`, cp.token, { reason: 'EMERGENCY' });
const after = await call('GET', '/api/assistant/v1/assistant/handoffs/summary', desk);
check(after.open === before.open + 1 && after.emergency === before.emergency + 1, `desk alert counts: ${after.open} waiting, ${after.emergency} emergency`);
check((await call('GET', '/api/assistant/v1/assistant/handoffs', desk)).list?.[0]?.reason === 'EMERGENCY', 'emergencies are first in the list');

// ======== B-2 offboarding ========
const leaver = await newStaff('leaver', 'RECEPTIONIST');
check((await call('POST', `/api/iam/v1/staff/${leaver.userId}/deactivate`, desk, { reason: 'test' })).http === 403, 'B-2 the desk cannot deactivate staff');
const me = (await call('GET', '/api/iam/v1/me', admin)).id;
check((await call('POST', `/api/iam/v1/staff/${me}/deactivate`, admin, { reason: 'nope' })).code === 'OWN_ACCOUNT', 'B-2 nobody deactivates themselves');
const de = await call('POST', `/api/iam/v1/staff/${leaver.userId}/deactivate`, admin, { reason: 'Left on 30 October' });
check(de.status === 'DISABLED' && de.loginDisabled === true, 'B-2 deactivated: login disabled (works nowhere else)');
const lcaps = await call('GET', '/api/entitlement/v1/me/capabilities', leaver.token);
check(lcaps.http !== 200 || lcaps.permissions?.length === 0, 'B-2 their still-valid token carries no permissions any more');
check(await staffToken(leaver.email).then(() => false, () => true), 'B-2 they can no longer sign in');
check((await call('GET', `/api/iam/v1/staff/${leaver.userId}`, admin)).disabledReason === 'Left on 30 October', 'B-2 who/why kept on the staff record');
const re = await call('POST', `/api/iam/v1/staff/${leaver.userId}/reactivate`, admin, {});
check(re.status === 'ACTIVE' && !!(await waitFor(() => staffToken(leaver.email).catch(() => null), 10000, 1000)), 'B-2 reactivated: can sign in again (roles are given again by the admin)');
psql(`UPDATE iam.staff_members SET status = 'INVITED', invite_sent_at = now() - interval '1 hour' WHERE user_id = '${leaver.userId}'`);
check((await call('POST', `/api/iam/v1/staff/${leaver.userId}/resend-invite`, admin, {})).sent === true, 'B-2 invite resent');
check(!!(await waitFor(async () => (await mail(`to:${leaver.email}`)).length > 0, 20000, 1000)), 'B-2 the invite e-mail arrived (Keycloak → Mailpit)');
check((await call('POST', `/api/iam/v1/staff/${leaver.userId}/resend-invite`, admin, {})).code === 'TOO_SOON', 'B-2 not twice within two minutes');
psql(`UPDATE iam.staff_members SET status = 'ACTIVE' WHERE user_id = '${leaver.userId}'`);
const rs = await call('POST', `/api/iam/v1/staff/${leaver.userId}/reset-sign-in`, admin, { password: true, authenticator: true });
check(rs.sent === true && rs.reset.join() === 'UPDATE_PASSWORD,CONFIGURE_TOTP', 'B-2 password and authenticator reset e-mailed; sessions ended');

// ======== B-8 admin actions are audited ========
const audit = await waitFor(async () => {
  const l = (await call('GET', '/api/audit/v1/audit?purpose=ADMIN', admin)).items ?? [];
  const has = (t, c) => l.some((e) => e.resourceType === t && e.resourceId === leaver.userId && (!c || e.changes?.includes(c)));
  return has('STAFF', 'deactivated') && has('STAFF', 'reactivated') && has('STAFF', 'password_reset') && has('STAFF_INVITE') && l;
}, 20000, 1000);
check(!!audit, 'B-8 invite, deactivate, reactivate and reset are in the audit log (purpose ADMIN)');
await call('POST', `/api/entitlement/v1/users/${leaver.userId}/roles`, admin, { roleCode: 'RECEPTIONIST', branchId: B.id });
const s0 = await call('PUT', '/api/entitlement/v1/settings/appointments.cancel_cutoff_hours', admin, { value: 4 });
const audit2 = await waitFor(async () => {
  const l = (await call('GET', '/api/audit/v1/audit?purpose=ADMIN', admin)).items ?? [];
  return l.some((e) => e.resourceType === 'ROLE_GRANT' && e.resourceId === leaver.userId && e.changes?.includes('roleCode')) && (s0.http !== 200 || l.some((e) => e.resourceType === 'SETTING' && e.changes?.includes('appointments.cancel_cutoff_hours')));
}, 20000, 1000);
check(!!audit2, `B-8 role grants and settings changes are audited${s0.http !== 200 ? ` (setting not changeable here: ${s0.code})` : ''}`);
const ba2 = await newStaff('bradmin', 'BRANCH_ADMIN', B.id);
check((await call('GET', '/api/audit/v1/audit?purpose=ADMIN', ba2.token)).http === 403, 'B-4 a branch admin cannot read the hospital audit log');

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mwave 2: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
