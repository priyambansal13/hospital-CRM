#!/usr/bin/env node
// Clinical records test (Phase 12), against the local gateway:
//   the treating doctor opens a visit from the appointment, writes vitals/notes/diagnoses (notes encrypted at rest),
//   signs, amends, prescribes (PDF, "prescription ready" SMS without drug names); another doctor is refused, uses
//   break-glass, then can read; an admin can't read clinical notes; the patient sees prescriptions and who opened
//   their record; the audit log is append-only, hash-chained (a tamper is detected) and fail-closed.
import { execFileSync } from 'node:child_process';
import { readFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql, db = 't_citycare') => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const psqlError = (sql) => { try { psql(sql); return null; } catch (e) { return String(e.stderr ?? e.message); } };
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
async function patient(name) {
  const phone = `+9190${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  let code;
  for (let i = 0; i < 30 && !code; i++) { await sleep(200); code = (await sms(phone)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6); }
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1972-02-14', gender: 'FEMALE' });
  return { token, phone, self };
}
const waitFor = async (fn, ms = 15000, every = 400) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };

// ---- setup: a patient with a checked-in visit to Dr. Asha Rao
const P = await patient('Records Patient');
const [desk, asha, other, admin] = await Promise.all([staffToken('desk@citycare.test'), staffToken('asha.rao@citycare.test'), staffToken('leak.doctor@citycare.test'), staffToken('admin@citycare.test')]);
const me = await call('GET', '/api/scheduling/v1/me/doctor', asha);
const branchId = (await call('GET', `/api/scheduling/v1/doctors/${me.id}/schedule`, asha)).doctor?.branchIds?.[0]
  ?? (await call('GET', '/api/tenant/v1/branches', desk))._body.find((b) => b.name === 'Sector 44').id;
await sleep(1500);
const appt = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: P.self.id, walkIn: { doctorId: me.id, branchId }, reason: 'thirst, tiredness' }, undefined, idem());
check(appt._body.status === 'CHECKED_IN', `walk-in checked in for ${P.self.mrn} (${appt.appointmentNo})`);

// ---- 1. the visit
check((await call('POST', '/api/records/v1/encounters', desk, { appointmentId: appt.id })).status === 403, 'a receptionist cannot open a visit (403)');
const opened = await waitFor(async () => { const r = await call('POST', '/api/records/v1/encounters', asha, { appointmentId: appt.id }); return r.status === 201 && r; });
check(opened?.created === true && opened.encounter.status === 'OPEN' && opened.encounter.patient.age >= 50, `Dr. Asha Rao opens the visit (patient ${opened?.encounter.patient.name}, ${opened?.encounter.patient.age} y)`);
const enc = opened.encounter;
check((await call('POST', '/api/records/v1/encounters', asha, { appointmentId: appt.id })).created === false, 'opening again returns the same visit');
check((await call('PATCH', `/api/records/v1/encounters/${enc.id}`, asha, { version: enc.version, vitals: { bp: '140-90' } })).status === 400, 'vitals are validated (BP like 120/80)');
check((await call('PATCH', `/api/records/v1/encounters/${enc.id}`, asha, { version: enc.version, diagnoses: [{ code: 'Z99.99' }] })).code === 'UNKNOWN_ICD10', 'unknown ICD-10 code refused');
const icd = await call('GET', '/api/records/v1/icd10?q=diabetes', asha);
check(icd._body.some((c) => c.code === 'E11.9'), `ICD-10 search: "diabetes" → ${icd._body.map((c) => c.code).slice(0, 4).join(', ')}…`);
const NOTE = 'Polyuria and polydipsia for 3 weeks. Random glucose 312. Started on metformin; diet counselling given.';
const upd = await call('PATCH', `/api/records/v1/encounters/${enc.id}`, asha, {
  version: enc.version, vitals: { bp: '138/88', pulse: 84, tempC: 36.9, weightKg: 82, spo2: 98 }, chiefComplaint: 'Excessive thirst and tiredness',
  notes: NOTE, diagnoses: [{ code: 'E11.9', isPrimary: true }, { code: 'I10' }],
});
check(upd.status === 200 && upd.notes === NOTE && upd.diagnoses.length === 2 && upd.diagnoses[0].code === 'E11.9', 'notes, complaint, vitals and 2 diagnoses saved');
check((await call('PATCH', `/api/records/v1/encounters/${enc.id}`, asha, { version: enc.version, notes: 'stale' })).code === 'VERSION_CONFLICT', 'a stale save (old version) → 409');
const raw = psql(`SELECT encode(notes_enc, 'escape') FROM records.encounters WHERE id = '${enc.id}'`);
check(raw.length > 40 && !raw.includes('Polyuria') && !raw.includes('metformin'), 'notes are encrypted at rest (the column has no readable text)');
check(psql(`SELECT count(*) FROM records.tenant_keys`, 'mc_control') !== '0', "the hospital's data key is stored wrapped in the control plane");
check((await call('PATCH', `/api/records/v1/encounters/${enc.id}`, other, { version: upd.version, notes: 'x' })).code === 'NOT_AUTHOR', 'another doctor cannot edit this visit');

const signed = await call('POST', `/api/records/v1/encounters/${enc.id}/sign`, asha, { version: upd.version });
check(signed._body.status === 'SIGNED' && !!signed.signedAt, 'visit signed');
check((await call('PATCH', `/api/records/v1/encounters/${enc.id}`, asha, { version: signed.version, notes: 'edit' })).code === 'ENCOUNTER_SIGNED', 'a signed visit cannot be edited in place');
const amended = await call('POST', `/api/records/v1/encounters/${enc.id}/amendments`, asha, { reason: 'Lab result added', notes: `${NOTE} HbA1c 9.1%.` });
check(amended._body.status === 'AMENDED' && amended.amendments?.length === 1 && amended.notes.endsWith('HbA1c 9.1%.'), 'amendment recorded with its reason; previous text kept');

const rx = await call('POST', `/api/records/v1/encounters/${enc.id}/prescriptions`, asha, {
  items: [{ drugName: 'Metformin', strength: '500 mg', form: 'tablet', dosage: '1-0-1', durationDays: 30, instructions: 'after food' }, { drugName: 'Telmisartan', strength: '40 mg', form: 'tablet', dosage: '1-0-0', durationDays: 30 }],
  advice: 'Walk 30 minutes daily. Avoid sugary drinks.', followUpOn: '2026-12-01',
}, undefined, idem());
check(rx.status === 201 && /^RX-\d{4}-\d{6}$/.test(rx.prescriptionNo) && rx.items.length === 2, `prescription ${rx.prescriptionNo} issued (2 medicines)`);
const pdf = await fetch(`${G}/api/records/v1/prescriptions/${rx.id}/pdf`, { headers: { 'x-tenant-host': 'citycare.localhost', authorization: `Bearer ${P.token}` } });
check(pdf.headers.get('content-type') === 'application/pdf' && Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString() === '%PDF-', 'patient downloads the prescription PDF');
const rxSms = await waitFor(async () => (await sms(P.phone)).find((m) => m.Snippet.includes(rx.prescriptionNo)), 20000, 1000);
check(!!rxSms && !/metformin|telmisartan|diabet/i.test(rxSms.Snippet), `"prescription ready" SMS has no drug or diagnosis: "${rxSms?.Snippet.slice(0, 80)}…"`);

// ---- 2. access policy
const denied = await call('GET', `/api/records/v1/patients/${P.self.id}/chart`, other);
check(denied.status === 403 && denied.code === 'NO_TREATING_RELATIONSHIP' && denied.breakGlassAvailable === true, 'a doctor with no relationship is refused (offered break-glass)');
const adminChart = await call('GET', `/api/records/v1/patients/${P.self.id}/chart`, admin);
check(adminChart.status === 403, 'the hospital admin cannot read clinical notes (403)');
const look = await call('GET', `/api/records/v1/patients/lookup?mrn=${P.self.mrn}`, other);
check(look.access === 'NONE' && look.patient.id === P.self.id, 'MRN lookup tells the other doctor they have no access');
check((await call('POST', `/api/records/v1/patients/${P.self.id}/break-glass`, other, { reason: 'urgent' })).status === 400, 'break-glass needs a real reason');
const bg = await call('POST', `/api/records/v1/patients/${P.self.id}/break-glass`, other, { reason: 'Patient unconscious in emergency; need medication history' });
check(bg.status === 201 && Date.parse(bg.expiresAt) > Date.now() + 3 * 3600_000, `break-glass granted until ${bg.expiresAt}`);
const viaBg = await call('GET', `/api/records/v1/patients/${P.self.id}/chart`, other);
check(viaBg.status === 200 && viaBg.access.purpose === 'BREAK_GLASS' && viaBg.encounters[0]?.notes?.includes('HbA1c'), 'with break-glass the chart opens (marked emergency access)');
const treat = await call('GET', `/api/records/v1/patients/${P.self.id}/chart`, asha);
check(treat.access?.purpose === 'TREATMENT', 'the treating doctor reads it as treatment');
check((await call('GET', `/api/records/v1/patients/${P.self.id}/chart`, await staffToken('admin@sunrise.test', 'sunrise'), undefined, 'sunrise.localhost')).status === 404, 'another hospital: 404');

// ---- 3. the patient's view
const mine = await call('GET', '/api/records/v1/me/prescriptions', P.token);
check(mine._body.length === 1 && mine._body[0].prescriptionNo === rx.prescriptionNo && mine._body[0].diagnoses[0].code === 'E11.9', 'patient sees their prescription with the diagnosis');
check((await call('GET', `/api/records/v1/encounters/${enc.id}`, P.token)).status === 403, "patients don't get the doctor's notes API (403)");
const log = await waitFor(async () => { const l = await call('GET', `/api/audit/v1/me/access-log?patientId=${P.self.id}`, P.token); return l._body.some?.((e) => e.purpose === 'BREAK_GLASS') && l; });
const who = new Set(log?._body.map((e) => `${e.who}:${e.purpose}`));
check(who.has('Dr. Asha Rao:TREATMENT') && who.has('Dr. Leak Test:BREAK_GLASS') && !log._body.some((e) => e.purpose === 'PATIENT_SELF'), `access log: ${[...who].join(', ')}`);
const notMine = await patient('Someone Else');
check((await call('GET', `/api/audit/v1/me/access-log?patientId=${P.self.id}`, notMine.token)).status === 404, "another patient can't read this access log (404)");

// ---- 4. the audit log itself
const adminLog = await call('GET', `/api/audit/v1/audit?patientId=${P.self.id}`, admin);
const actions = new Set(adminLog.items?.map((e) => e.action));
check(['CREATE', 'UPDATE', 'SIGN', 'AMEND', 'READ', 'EXPORT', 'DENIED', 'LOOKUP', 'BREAK_GLASS'].every((a) => actions.has(a)) && adminLog.breakGlassLast7Days >= 1, `admin audit log has ${[...actions].sort().join(', ')}`);
check(!JSON.stringify(adminLog).includes('Polyuria'), 'audit entries carry no clinical text');
check((await call('GET', '/api/audit/v1/audit', desk)).status === 403, 'a receptionist cannot read the audit log (403)');
check((await call('GET', '/api/audit/v1/audit/verify', admin)).ok === true, 'hash chain verifies');
check(/append-only/.test(psqlError(`UPDATE audit.audit_log SET actor_name = 'x' WHERE patient_id = '${P.self.id}'`) ?? ''), 'UPDATE on the audit log is refused (append-only)');
check(/append-only/.test(psqlError(`DELETE FROM audit.audit_log WHERE patient_id = '${P.self.id}'`) ?? ''), 'DELETE on the audit log is refused');
// a superuser who disables the guard and edits a row is caught by the chain
const victim = psql(`SELECT id || '|' || coalesce(actor_name, '') FROM audit.audit_log WHERE patient_id = '${P.self.id}' AND action = 'BREAK_GLASS' LIMIT 1`).split('|');
psql(`ALTER TABLE audit.audit_log DISABLE TRIGGER audit_log_no_update; UPDATE audit.audit_log SET actor_name = 'Nobody' WHERE id = ${victim[0]}; ALTER TABLE audit.audit_log ENABLE TRIGGER audit_log_no_update;`);
const broken = await call('GET', '/api/audit/v1/audit/verify', admin);
check(broken.ok === false && broken.firstBrokenId === victim[0], `tampering detected at entry ${broken.firstBrokenId}: ${broken.problem}`);
psql(`ALTER TABLE audit.audit_log DISABLE TRIGGER audit_log_no_update; UPDATE audit.audit_log SET actor_name = '${victim[1].replace(/'/g, "''")}' WHERE id = ${victim[0]}; ALTER TABLE audit.audit_log ENABLE TRIGGER audit_log_no_update;`);
check((await call('GET', '/api/audit/v1/audit/verify', admin)).ok === true, 'restored row → chain verifies again');

// ---- 5. fail closed: no audit service → no patient data
const pid = execFileSync('lsof', ['-t', '-iTCP:4411', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0];
process.kill(Number(pid));
await sleep(1500);
const closed = await call('GET', `/api/records/v1/patients/${P.self.id}/chart`, asha);
check(closed.status === 503 && closed.code === 'AUDIT_UNAVAILABLE', 'audit-service down → the chart is NOT shown (503 AUDIT_UNAVAILABLE)');
const main = join(PLATFORM, '../backend/services/audit-service/dist/main.js');
utimesSync(main, new Date(), new Date()); // node --watch restarts it
check(!!(await waitFor(async () => (await fetch('http://localhost:4411/health').catch(() => ({ ok: false }))).ok, 30000, 1000)), 'audit-service back');
check((await call('GET', `/api/records/v1/patients/${P.self.id}/chart`, asha)).status === 200, 'chart readable again');

console.log(failures ? `\x1b[31m${failures} failure(s)\x1b[0m` : '\x1b[32mrecords ok\x1b[0m');
process.exit(failures ? 1 : 0);
