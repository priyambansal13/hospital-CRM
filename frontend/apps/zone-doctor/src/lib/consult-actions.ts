'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import type { Diagnosis, Encounter } from './records';

/** Consultation screen actions; each saves through records-service and comes back to the page. */
const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path || 'form'}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');
const back = async (path: string, q: Record<string, string>) => redirect(`${await origin()}${path.startsWith('/doctor/') ? path : '/doctor/queue'}?${new URLSearchParams(q)}`);
const num = (f: FormData, k: string) => { const v = String(f.get(k) ?? '').trim(); return v ? Number(v) : undefined; };
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const RX_ROWS = 8;

async function run(f: FormData, call: (token: string) => Promise<unknown>, ok: string) {
  const { accessToken: token } = await actionSession();
  const path = str(f, 'back');
  try {
    await call(token);
  } catch (e) {
    return back(path, { error: msg(e) });
  }
  return back(path, { ok });
}

export async function startVisit(f: FormData) {
  return run(f, (token) => api('/api/records/v1/encounters', { token, body: { appointmentId: str(f, 'appointmentId') } }), 'Visit started');
}

/** Save the draft (vitals, complaint, notes); diagnoses are edited with their own buttons. */
export async function saveDraft(f: FormData) {
  const vitals = Object.fromEntries(Object.entries({ bp: str(f, 'bp') || undefined, pulse: num(f, 'pulse'), tempC: num(f, 'tempC'), spo2: num(f, 'spo2'), weightKg: num(f, 'weightKg') }).filter(([, v]) => v !== undefined));
  return run(f, (token) => api(`/api/records/v1/encounters/${str(f, 'encounterId')}`, {
    token, method: 'PATCH', body: { version: Number(f.get('version')), vitals, chiefComplaint: str(f, 'chiefComplaint') || null, notes: str(f, 'notes') || null },
  }), 'Saved');
}

async function setDiagnoses(f: FormData, edit: (list: Diagnosis[]) => Diagnosis[], ok: string) {
  return run(f, async (token) => {
    const e = await api<Encounter>(`/api/records/v1/encounters/${str(f, 'encounterId')}`, { token });
    await api(`/api/records/v1/encounters/${e.id}`, { token, method: 'PATCH', body: { version: e.version, diagnoses: edit(e.diagnoses.map((d) => ({ code: d.code, description: d.description, isPrimary: !!d.isPrimary }))) } });
  }, ok);
}
export async function addDiagnosis(f: FormData) {
  const code = str(f, 'code') || null;
  const description = str(f, 'description') || null;
  return setDiagnoses(f, (l) => (l.some((d) => code && d.code === code) ? l : [...l, { code, description: description ?? '', isPrimary: l.length === 0 }]), `Diagnosis added${code ? ` (${code})` : ''}`);
}
export async function removeDiagnosis(f: FormData) {
  const i = Number(f.get('index'));
  return setDiagnoses(f, (l) => l.filter((_, n) => n !== i), 'Diagnosis removed');
}
export async function makePrimary(f: FormData) {
  const i = Number(f.get('index'));
  return setDiagnoses(f, (l) => l.map((d, n) => ({ ...d, isPrimary: n === i })), 'Primary diagnosis set');
}

export async function signVisit(f: FormData) {
  return run(f, (token) => api(`/api/records/v1/encounters/${str(f, 'encounterId')}/sign`, { token, body: { version: Number(f.get('version')) } }), 'Visit signed');
}

export async function amendVisit(f: FormData) {
  return run(f, (token) => api(`/api/records/v1/encounters/${str(f, 'encounterId')}/amendments`, { token, body: { reason: str(f, 'reason'), notes: str(f, 'notes') || null } }), 'Amendment saved');
}

export async function issuePrescription(f: FormData) {
  const items = Array.from({ length: RX_ROWS }, (_, i) => ({
    drugName: str(f, `drug${i}`), strength: str(f, `strength${i}`) || null, form: str(f, `form${i}`) || null,
    dosage: str(f, `dosage${i}`), durationDays: num(f, `days${i}`) ?? null, instructions: str(f, `instr${i}`) || null,
  })).filter((i) => i.drugName);
  const body = { items, advice: str(f, 'advice') || null, followUpOn: str(f, 'followUpOn') || null };
  const { accessToken: token } = await actionSession();
  const path = str(f, 'back');
  try {
    await api(`/api/records/v1/encounters/${str(f, 'encounterId')}/prescriptions`, { token, idempotencyKey: str(f, 'idempotencyKey'), body: { ...body, allergyOverride: str(f, 'allergyOverride') || null } });
  } catch (e) {
    // allergy clash (or allergies unreadable): back to the form, filled in, asking for a reason (review C-3)
    if (e instanceof ApiError && (e.code === 'ALLERGY_CONFLICT' || e.code === 'ALLERGIES_UNAVAILABLE')) {
      return back(path, { error: msg(e), allergy: '1', rx: Buffer.from(JSON.stringify(body)).toString('base64url') });
    }
    return back(path, { error: msg(e) });
  }
  return back(path, { ok: 'Prescription issued' });
}

/** Emergency access: always audited; the chart opens for a few hours. */
export async function breakGlass(f: FormData) {
  return run(f, (token) => api(`/api/records/v1/patients/${str(f, 'patientId')}/break-glass`, { token, body: { reason: str(f, 'reason') } }), 'Emergency access granted. This is recorded and reviewed.');
}

export async function finishVisit(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/scheduling/v1/appointments/${str(f, 'appointmentId')}/complete`, { token, method: 'POST' });
  } catch (e) {
    return back(str(f, 'back'), { error: msg(e), ...(e instanceof ApiError && e.code === 'NOTE_NOT_SIGNED' ? { unsigned: '1' } : {}) });
  }
  redirect(`${await origin()}/doctor/queue?${new URLSearchParams({ ok: 'Visit completed' })}`);
}

export async function addAllergyForPatient(f: FormData) {
  return run(f, (token) => api(`/api/patient/v1/patients/${str(f, 'patientId')}/allergies`, {
    token, body: { substance: str(f, 'substance'), severity: str(f, 'severity') || 'UNKNOWN', reaction: str(f, 'reaction') || null },
  }), `${str(f, 'substance')} allergy recorded`);
}

export async function orderLabTests(f: FormData) {
  const items = [...f.getAll('pkg').map((p) => ({ packageId: String(p) })), ...f.getAll('test').map((t) => ({ testId: String(t) }))];
  const { accessToken: token } = await actionSession();
  const path = str(f, 'back');
  if (!items.length) return back(path, { error: 'Pick at least one test' });
  let orderNo: string;
  try {
    orderNo = (await api<{ orderNo: string }>('/api/diagnostics/v1/doctor/lab-orders', {
      token, idempotencyKey: str(f, 'idempotencyKey'), body: { patientId: str(f, 'patientId'), encounterId: str(f, 'encounterId') || null, items, note: str(f, 'note') || null },
    })).orderNo;
  } catch (e) {
    return back(path, { error: msg(e) });
  }
  return back(path, { ok: `Lab tests ordered (${orderNo}). The patient has been asked to pick a collection time.` });
}
