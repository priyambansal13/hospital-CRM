#!/usr/bin/env node
// Phase 25: deterministic prescription safety and the AI scribe, against a real visit built here. The "recording" is
// a real WAV file (one second of silence) that carries the mock consultation in its comment: the offline dev model
// reads it from there; LLM_PROVIDER=gemini would transcribe real speech instead.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const HOST = 'citycare.localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host = HOST) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': host, 'idempotency-key': crypto.randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
async function staffToken(email, slug = 'citycare') {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const waitFor = async (fn, ms = 20000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
const psql = (sql, db = 't_citycare') => execFileSync('docker', ['exec', 'medicare-postgres-1', 'psql', '-U', 'postgres', '-d', db, '-tAc', sql], { encoding: 'utf8' }).trim();
const SFX = Date.now().toString().slice(-6);

async function patient(name) {
  const phone = `+9192${String(Date.now()).slice(-8)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const code = await waitFor(async () => {
    const m = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.slice(1)}@sms.medicare.local`)}`)).json();
    return m.messages?.[0]?.Snippet?.match(/\d{6}/)?.[0];
  });
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1958-05-05', gender: 'MALE' });
  return { token, self, phone };
}

/** A WAV file: one second of 8 kHz silence, with the transcript in its LIST/INFO/ICMT comment. */
function mockRecording(transcript) {
  const pcm = Buffer.alloc(8000 * 2);
  const text = Buffer.from(`${transcript}\0`, 'utf8');
  const icmt = Buffer.concat([Buffer.from('ICMT'), Buffer.alloc(4), text, text.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  icmt.writeUInt32LE(text.length, 4);
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.alloc(4), Buffer.from('INFO'), icmt]);
  list.writeUInt32LE(4 + icmt.length, 4);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(8000, 12); fmt.writeUInt32LE(16000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const data = Buffer.concat([Buffer.from('data'), Buffer.alloc(4), pcm]);
  data.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, list, data]);
  const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), body]);
  riff.writeUInt32LE(body.length, 4);
  return riff;
}
const CONSULT = `Doctor: Good morning. What brings you in today?
Patient: I have had a sore throat and fever for three days.
Patient: It hurts to swallow. A little cough, no breathing trouble.
Doctor: Your temperature is 38.4, pulse 96, BP 122/80. Throat is red and the tonsils are swollen.
Doctor: This looks like acute tonsillitis.
Doctor: I will start amoxicillin 500 mg three times a day for 5 days, and paracetamol 650 mg when needed for fever for 3 days.
Doctor: Let us also do a CBC.
Doctor: Drink warm fluids and rest. Come back in 5 days if you are not better.`;

// ---- a patient on warfarin, allergic to penicillin ----
// a doctor of its own each run (an unfinished visit from an aborted run must not block the next one)
const [desk, admin] = await Promise.all(['desk', 'admin'].map((u) => staffToken(`${u}@citycare.test`)));
const branch = (await call('GET', '/api/tenant/v1/branches', admin)).list.find((b) => b.name === 'Sector 44');
const docEmail = `scribe.doc.${SFX}@citycare.test`;
const me = await call('POST', '/api/provider/v1/doctors', admin, { name: `Dr. Scribe ${SFX}`, email: docEmail, registrationNo: `SC/${SFX}`, specialties: [{ code: 'GENERAL_MEDICINE', primary: true }], branches: [{ branchId: branch.id, fee: 300 }], consultModes: ['IN_PERSON'] });
await call('POST', `/api/provider/v1/doctors/${me.id}/status`, admin, { status: 'ACTIVE' });
const asha = await waitFor(() => staffToken(docEmail).catch(() => null), 30000, 1000);
const P = await patient(`Scribe Patient ${SFX}`);
await call('POST', `/api/patient/v1/me/patients/${P.self.id}/allergies`, P.token, { substance: 'Penicillin', severity: 'SEVERE', reaction: 'swelling' });
let lastVisit;
const visit = async () => { const v = await waitFor(async () => { const r = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: P.self.id, walkIn: { doctorId: me.id, branchId: branch.id } }); lastVisit = r; return r.http === 201 && r; }, 20000, 1000); if (!v) throw new Error(`walk-in refused: ${lastVisit?.http} ${lastVisit?.code} ${lastVisit?.detail}`); return v; };
const open = async (apptId) => waitFor(async () => { const r = await call('POST', '/api/records/v1/encounters', asha, { appointmentId: apptId }); return r.http === 201 && r.encounter; }, 20000, 1000);
const v1 = await visit();
const e1 = await open(v1.id);
const u1 = await call('PATCH', `/api/records/v1/encounters/${e1.id}`, asha, { version: e1.version, chiefComplaint: 'High blood pressure follow-up', diagnoses: [{ code: 'I10', isPrimary: true }] });
const steps = [
  await call('POST', `/api/records/v1/encounters/${e1.id}/prescriptions`, asha, { items: [{ drugName: 'Warfarin', strength: '5 mg', dosage: '0-0-1', durationDays: 90 }] }),
  await call('POST', `/api/records/v1/encounters/${e1.id}/sign`, asha, { version: (u1.encounter ?? u1).version }),
  await call('POST', `/api/scheduling/v1/appointments/${v1.id}/start`, asha),
  await call('POST', `/api/scheduling/v1/appointments/${v1.id}/complete`, asha),
];
for (const x of steps) if (x.http >= 300) console.log(`  (earlier visit: ${x.http} ${x.code} ${x.detail})`);

// ======== 1. deterministic prescription safety ========
const v2 = await visit();
const e2 = await open(v2.id);
const chk = await call('POST', `/api/records/v1/patients/${P.self.id}/prescription-check`, asha, { items: [{ drugName: 'Augmentin 625' }, { drugName: 'Ibuprofen 400 mg' }, { drugName: 'Cefixime 200 mg' }] });
check(chk.allergies?.some((a) => a.drug === 'Augmentin 625' && a.level === 'BLOCK') && chk.allergies?.some((a) => a.drug === 'Cefixime 200 mg' && a.level === 'CAUTION'), `allergy: Augmentin blocked, cefixime a cross-reaction caution (${chk.allergies?.map((a) => `${a.drug} ${a.level}`).join(', ')})`);
check(chk.interactions?.some((i) => i.a === 'Ibuprofen 400 mg' && /Warfarin/.test(i.b) && i.severity === 'MAJOR' && i.withCurrent), `interaction with what the patient takes now: ibuprofen + warfarin (${chk.interactions?.[0]?.effect})`);
check(chk.matches?.every((m) => m.generic) && chk.current?.some((c) => /Warfarin/.test(c.drugName)), 'every drug matched in the formulary; warfarin found as a current medicine');
const rx = (extra) => call('POST', `/api/records/v1/encounters/${e2.id}/prescriptions`, asha, { items: [{ drugName: 'Ibuprofen', strength: '400 mg', dosage: '1-0-1', durationDays: 3 }], ...extra });
const r1 = await rx({});
check(r1.http === 409 && r1.code === 'INTERACTION_CONFLICT' && /taken now/.test(r1.detail ?? ''), `issuing it is refused: ${r1.code}`);
const r2 = await rx({ interactionOverride: 'short course, INR checked today' });
check(r2.http === 201 && psql(`SELECT interaction_override_reason FROM records.prescriptions WHERE id = '${r2.id}'`) === 'short course, INR checked today', 'with the doctor\'s reason it is issued, and the reason is kept');
check((await call('POST', `/api/records/v1/patients/${P.self.id}/prescription-check`, desk, { items: [{ drugName: 'Ibuprofen' }] })).http === 403, 'the front desk cannot run clinical checks');

// ======== 2. the scribe ========
const wav = mockRecording(CONSULT);
const up = (token = asha) => call('POST', `/api/records/v1/encounters/${e2.id}/recordings`, token, { mimeType: 'audio/wav', contentBase64: wav.toString('base64') });
check((await up()).code === 'CONSENT_REQUIRED', 'no recording without the patient\'s consent');
check((await call('POST', `/api/records/v1/encounters/${e2.id}/scribe-consent`, asha, { method: 'VERBAL' })).http === 200, 'the doctor records the patient\'s verbal consent');
const rec = await up();
check(rec.http === 201 && rec.sizeBytes === wav.length, `recording stored (${rec.sizeBytes} bytes)`);
const key = psql(`SELECT object_key FROM records.scribe_recordings WHERE id = '${rec.recordingId}'`);
check(key.startsWith(`scribe/${e2.id}/`), 'kept in the hospital\'s bucket under the visit');
const D = `/api/assistant/v1/assistant/scribe/encounters/${e2.id}`;
const d = await call('POST', `${D}/drafts`, asha, { recordingId: rec.recordingId });
const s = d.draft?.soap;
check(d.http === 200 && /sore throat and fever for three days/.test(s?.subjective ?? ''), `SOAP draft from the recording (${d.draft?.model}): S "${s?.subjective?.slice(0, 50)}…"`);
check(s?.objective?.vitals?.tempC === 38.4 && s?.objective?.vitals?.bp === '122/80' && /tonsils are swollen/.test(s?.objective?.examination ?? ''), 'O: temperature, pulse, BP and the examination');
check(s?.assessment?.[0]?.description === 'Acute tonsillitis' && d.draft?.checks?.icd10?.[0]?.valid === true, `A: ${s?.assessment?.[0]?.description} (${s?.assessment?.[0]?.icd10Suggestion}, a real ICD-10 code)`);
check(s?.plan?.medications?.length === 2 && d.draft?.checks?.medicines?.every((m) => m.formulary), `P: ${s?.plan?.medications?.map((m) => `${m.drug} ${m.strength} ${m.dosage} × ${m.durationDays} d`).join('; ')}: both in the formulary`);
check(d.draft?.checks?.labTests?.[0]?.testCode === 'CBC' && !!d.draft.checks.labTests[0].name, `P: lab test CBC matched to the catalog (${d.draft?.checks?.labTests?.[0]?.name})`);
check(d.draft?.checks?.safety?.allergies?.some((a) => /amoxicillin/i.test(a.drug) && a.level === 'BLOCK'), 'the safety rules flag the drafted amoxicillin against the penicillin allergy (not the model)');
check(psql(`SELECT count(*) FROM assistant.clinical_drafts WHERE id = '${d.draft?.id}' AND kind = 'SOAP' AND position('tonsil' in encode(draft_enc, 'escape')) = 0`) === '1', 'the draft (with its transcript) is stored encrypted');

// the doctor changes the antibiotic, takes the draft over, then signs
const final = { ...s, plan: { ...s.plan, medications: [{ drug: 'Azithromycin', strength: '500 mg', dosage: '1-0-0', durationDays: 3, instructions: '' }, s.plan.medications[1]] } };
const ap = await call('POST', `/api/assistant/v1/assistant/scribe/drafts/${d.draft?.id}/apply`, asha, { final });
check(ap.draft?.status === 'APPLIED' && ap.draft?.edited === true, 'taken over with the doctor\'s change (marked edited: the quality signal)');
check((await call('POST', `/api/assistant/v1/assistant/scribe/drafts/${d.draft?.id}/apply`, asha, { final })).http === 409, 'a draft is taken over once');
const enc = await call('GET', `/api/records/v1/encounters/${e2.id}`, asha);
const up2 = await call('PATCH', `/api/records/v1/encounters/${e2.id}`, asha, { version: enc.version, chiefComplaint: s.subjective, notes: `${s.objective.examination}\nPlan: ${s.plan.advice}`, diagnoses: [{ code: 'J03.9', isPrimary: true }], vitals: s.objective.vitals, aiDraftId: d.draft.id });
check((up2.encounter ?? up2).aiAssisted === true, 'the visit notes are marked AI-assisted');
await call('POST', `/api/records/v1/encounters/${e2.id}/prescriptions`, asha, { items: final.plan.medications.map((m) => ({ drugName: m.drug, strength: m.strength, dosage: m.dosage, durationDays: m.durationDays || null })) });
const signed = await call('POST', `/api/records/v1/encounters/${e2.id}/sign`, asha, { version: (up2.encounter ?? up2).version });
check(signed.http === 200, 'the doctor signs the visit');
check(psql(`SELECT delete_reason FROM records.scribe_recordings WHERE id = '${rec.recordingId}'`) === 'SIGNED', 'the recording is deleted once the visit is signed (the row stays as the trail)');
check((await fetch(`http://localhost:4410/internal/tenants/${psql('SELECT tenant_id FROM public.tenant_meta')}/recordings/${rec.recordingId}`, { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } })).status === 404, '…and can no longer be read');
check((await call('POST', `/api/records/v1/encounters/${e2.id}/recordings`, asha, { mimeType: 'audio/wav', contentBase64: wav.toString('base64') })).code === 'ENCOUNTER_SIGNED', 'no new recordings on a signed visit');

// ======== 3. who may ========
const other = await staffToken('leak.doctor@citycare.test').catch(() => null);
if (other) check((await call('GET', `${D}/draft`, other)).draft === null, 'another doctor does not see this doctor\'s draft');
check((await call('POST', `${D}/drafts`, P.token, { recordingId: rec.recordingId })).http === 403, 'a patient cannot use the scribe');

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mscribe: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
