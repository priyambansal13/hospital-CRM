#!/usr/bin/env node
// Documents, timeline, consents and allergies (Phase 13), against the local gateway + MinIO:
//   upload rules; direct PUT to the hospital's bucket; scan (clean → visible; EICAR → INFECTED; an .exe named .pdf
//   → REJECTED); 5-minute attachment downloads, audited; the timeline next to visits and prescriptions; a doctor
//   without a relationship gets in only with the patient's consent (per scope) until it is revoked; allergies.
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
  const phone = `+9189${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  let code;
  for (let i = 0; i < 30 && !code; i++) { await sleep(200); code = (await sms(phone)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6); }
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1980-03-03', gender: 'MALE' });
  return { token, phone, self };
}
const waitFor = async (fn, ms = 20000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'latin1');
const EXE = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'), Buffer.alloc(200)]);

/** request a URL, PUT the bytes straight to object storage, register → document */
async function upload(tok, patientId, bytes, mime, title, opts = {}) {
  const u = await call('POST', `/api/records/v1/patients/${patientId}/documents/upload-url`, tok, { fileName: `${title}.pdf`, mimeType: mime, sizeBytes: bytes.length });
  if (u.status !== 200) return { u };
  const put = await fetch(u.url, { method: 'PUT', headers: u.headers, body: bytes });
  const reg = await call('POST', `/api/records/v1/patients/${patientId}/documents`, tok, { uploadId: u.uploadId, title, type: opts.type ?? 'LAB_REPORT', issuedOn: opts.issuedOn ?? null });
  return { u, put, reg };
}
const scanned = (tok, id) => waitFor(async () => { const d = await call('GET', `/api/records/v1/documents/${id}`, tok); return !['PENDING', 'SCANNING'].includes(d.scanStatus) && d; });

// ---- setup: patient with a visit to Dr. Asha Rao (treating); Dr. Leak Test is not treating
const P = await patient('Docs Patient');
const [desk, asha, other] = await Promise.all([staffToken('desk@citycare.test'), staffToken('asha.rao@citycare.test'), staffToken('leak.doctor@citycare.test')]);
const me = await call('GET', '/api/scheduling/v1/me/doctor', asha);
const otherDoc = await call('GET', '/api/scheduling/v1/me/doctor', other);
const branchId = (await call('GET', '/api/tenant/v1/branches', desk))._body.find((b) => b.name === 'Sector 44').id;
await sleep(1500);
const appt = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: P.self.id, walkIn: { doctorId: me.id, branchId } }, undefined, idem());
check(appt._body.status === 'CHECKED_IN', `visit booked with Dr. Asha Rao (${appt.appointmentNo})`);
// records-service learns about the visit from scheduling events (a moment later): wait until Dr. Rao is treating
await waitFor(async () => (await call('GET', `/api/records/v1/patients/${P.self.id}/documents`, asha)).status === 200);

// ---- 1. upload rules
const P_ = P.self.id;
check((await call('POST', `/api/records/v1/patients/${P_}/documents/upload-url`, P.token, { fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 10 })).code === 'FILE_TYPE_NOT_ALLOWED', 'only PDF/JPEG/PNG/DICOM can be uploaded');
check((await call('POST', `/api/records/v1/patients/${P_}/documents/upload-url`, P.token, { fileName: 'big.pdf', mimeType: 'application/pdf', sizeBytes: 21 * 1024 * 1024 })).code === 'FILE_TOO_LARGE', 'over 20 MB is refused');
const early = await call('POST', `/api/records/v1/patients/${P_}/documents/upload-url`, P.token, { fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 100 });
check((await call('POST', `/api/records/v1/patients/${P_}/documents`, P.token, { uploadId: early.uploadId, title: 'Early' })).code === 'UPLOAD_MISSING', 'registering before the file arrived → 422');
check(/X-Amz-Expires=300/.test(early.url) && early.url.includes('/quarantine%2F') === false && early.url.includes(`quarantine/${P_}/`), `upload URL: 5 minutes, into quarantine/ (${new URL(early.url).pathname.split('/')[1]})`);
const stranger = await patient('Other Docs Patient');
check((await call('POST', `/api/records/v1/patients/${P_}/documents/upload-url`, stranger.token, { fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 100 })).status === 404, "another patient can't upload to this record (404)");
check((await call('POST', `/api/records/v1/patients/${P_}/documents/upload-url`, other, { fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 100 })).status === 403, "a doctor who isn't treating can't upload (403)");

// ---- 2. clean upload
const ok = await upload(P.token, P_, PDF, 'application/pdf', 'Blood test from City Lab', { issuedOn: '2026-10-01' });
check(ok.put.status === 200 && ok.reg.status === 201 && ok.reg._body.scanStatus === 'PENDING', 'patient PUTs a PDF straight to storage and registers it (PENDING)');
check((await call('GET', `/api/records/v1/patients/${P_}/documents`, asha))._body.every?.((d) => d.id !== ok.reg.id), 'not visible to the doctor while unscanned');
const clean = await scanned(P.token, ok.reg.id);
check(clean?.scanStatus === 'CLEAN', `scanned → CLEAN (${psql(`SELECT scan_detail FROM records.medical_documents WHERE id = '${ok.reg.id}'`)})`);
check(psql(`SELECT storage_key FROM records.medical_documents WHERE id = '${ok.reg.id}'`) === `clean/${P_}/${ok.reg.id}.pdf` && psql(`SELECT sha256 FROM records.medical_documents WHERE id = '${ok.reg.id}'`).length === 64, 'moved to clean/, SHA-256 recorded');
const dl = await call('GET', `/api/records/v1/documents/${ok.reg.id}/download`, P.token);
const file = await fetch(dl.url);
check(file.status === 200 && Buffer.from(await file.arrayBuffer()).equals(PDF) && /attachment/.test(file.headers.get('content-disposition') ?? '') && /X-Amz-Expires=300/.test(dl.url), 'download: 5-minute link, attachment, same bytes');
const tampered = new URL(dl.url); tampered.searchParams.set('X-Amz-Expires', '3600'); // plausible longer life: only the signature can catch it
const tr = await fetch(tampered);
const forged = await fetch(dl.url.replace(/X-Amz-Signature=[0-9a-f]{8}/, 'X-Amz-Signature=00000000'));
check(tr.status === 403 && forged.status === 403, `a download link edited to last an hour (${tr.status}) or with a forged signature (${forged.status}) is refused by storage`);

// ---- 3. infected and impostor files
const bad = await upload(P.token, P_, Buffer.concat([Buffer.from('%PDF-1.4\n'), EICAR]), 'application/pdf', 'Suspicious attachment');
check((await scanned(P.token, bad.reg.id))?.scanStatus === 'INFECTED', `EICAR inside a PDF → INFECTED (${psql(`SELECT scan_detail FROM records.medical_documents WHERE id = '${bad.reg.id}'`)})`);
const exe = await upload(P.token, P_, EXE, 'application/pdf', 'Totally a report');
const ex = await scanned(P.token, exe.reg.id);
check(ex?.scanStatus === 'REJECTED' && /not a PDF/.test(ex.scanDetail ?? ''), `Windows executable named .pdf → REJECTED ("${ex?.scanDetail}")`);
check((await call('GET', `/api/records/v1/documents/${bad.reg.id}/download`, P.token)).code === 'NOT_AVAILABLE', 'refused files cannot be downloaded');
check((await fetch(`http://localhost:61900/${'medicare-dev-t-citycare'}/${bad.u.url.split('/medicare-dev-t-citycare/')[1].split('?')[0]}`)).status !== 200, 'the infected object is gone from storage');

// ---- 4. timeline
const tl = await call('GET', `/api/records/v1/patients/${P_}/timeline`, P.token);
const kinds = tl.items?.map((i) => i.kind) ?? [];
check(kinds.includes('DOCUMENT') && kinds.includes('APPOINTMENT') && !tl.items.some((i) => i.title === 'Suspicious attachment'), `patient timeline: ${kinds.join(', ')} (refused files not shown)`);
const docTl = await call('GET', `/api/records/v1/patients/${P_}/timeline?kind=DOCUMENT`, asha);
check(docTl.items?.length === 1 && docTl.access.purpose === 'TREATMENT', 'the treating doctor sees the document on the timeline');

// ---- 5. consent: share documents only, then revoke
check((await call('GET', `/api/records/v1/patients/${P_}/documents`, other)).status === 403, 'Dr. Leak Test (no relationship) is refused');
const grant = await call('POST', '/api/patient/v1/me/consents', P.token, { patientId: P_, doctorId: otherDoc.id, scope: ['DOCUMENTS'], days: 7 });
check(grant.status === 201 && grant.active && grant.doctor.name === 'Dr. Leak Test', `patient shares documents with ${grant.doctor?.name} for 7 days`);
check((await call('POST', '/api/patient/v1/me/consents', stranger.token, { patientId: P_, doctorId: otherDoc.id, scope: ['NOTES'], days: 7 })).status === 404, "another patient can't share this record");
const viaConsent = await waitFor(async () => { const r = await call('GET', `/api/records/v1/patients/${P_}/documents`, other); return r.status === 200 && r; });
check(viaConsent?._body.length === 1, 'with consent the doctor sees the documents');
check((await call('GET', `/api/records/v1/patients/${P_}/chart`, other)).status === 403, '…but not the visit notes (not shared)');
const ctl = await call('GET', `/api/records/v1/patients/${P_}/timeline`, other);
check(ctl.access?.purpose === 'CONSENT' && ctl.items.every((i) => ['APPOINTMENT', 'DOCUMENT'].includes(i.kind)), `consented timeline shows only ${[...new Set(ctl.items?.map((i) => i.kind))].join(', ')}`);
await call('DELETE', `/api/patient/v1/me/consents/${grant.id}`, P.token);
check(!!(await waitFor(async () => (await call('GET', `/api/records/v1/patients/${P_}/documents`, other)).status === 403)), 'revoked → refused again');
const log = await call('GET', `/api/audit/v1/me/access-log?patientId=${P_}`, P.token);
check(log._body.some((e) => e.who === 'Dr. Leak Test' && e.purpose === 'CONSENT') && log._body.some((e) => e.action === 'EXPORT' && e.purpose === 'PATIENT_SELF') === false, 'access log: the consented reads are listed (the patient\'s own downloads are not)');

// ---- 6. allergies
const al = await call('POST', `/api/patient/v1/me/patients/${P_}/allergies`, P.token, { substance: 'Penicillin', severity: 'SEVERE', reaction: 'Hives, swelling' });
check(al.status === 201, 'patient records a penicillin allergy');
check((await call('POST', `/api/patient/v1/me/patients/${P_}/allergies`, P.token, { substance: 'penicillin' })).code === 'ALLERGY_EXISTS', 'the same allergy twice → 409');
const seen = await call('GET', `/api/patient/v1/patients/${P_}/allergies`, asha);
check(seen._body.some?.((a) => a.substance === 'Penicillin' && a.severity === 'SEVERE'), 'the treating doctor sees it');
check((await call('POST', `/api/patient/v1/patients/${P_}/allergies`, asha, { substance: 'Sulfonamides', severity: 'MODERATE' })).status === 201, 'the treating doctor adds one too');
check((await call('GET', `/api/patient/v1/me/patients/${P_}/allergies`, P.token))._body.some((a) => a.substance === 'Sulfonamides' && a.recordedBy.name === 'Dr. Asha Rao'), "patient sees the doctor's entry, with who recorded it");
check((await call('GET', `/api/patient/v1/patients/${P_}/allergies`, other)).status === 403, 'a doctor without a relationship cannot read allergies');
check((await call('GET', `/api/patient/v1/patients/${P_}/allergies`, desk)).status === 403, 'a receptionist cannot read allergies');
check((await call('GET', `/api/audit/v1/me/access-log?patientId=${P_}`, P.token))._body.some((e) => e.what === 'ALLERGIES' && e.who === 'Dr. Asha Rao'), 'allergy reads are audited');

// ---- 7. other hospital
check((await call('GET', `/api/records/v1/documents/${ok.reg.id}/download`, await staffToken('admin@sunrise.test', 'sunrise'), undefined, 'sunrise.localhost')).status === 404, 'another hospital: 404');

console.log(failures ? `\x1b[31m${failures} failure(s)\x1b[0m` : '\x1b[32mdocuments ok\x1b[0m');
process.exit(failures ? 1 : 0);
