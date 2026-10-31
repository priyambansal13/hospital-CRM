'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** The AI scribe panel's actions (Phase 25). Each saves through the services and comes back to the consult page. */
const back = async (path: string, q: Record<string, string>) => redirect(`${await origin()}${path.startsWith('/doctor/') ? path : '/doctor/queue'}?${new URLSearchParams(q)}`);
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export async function recordConsent(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/records/v1/encounters/${encodeURIComponent(str(f, 'encounterId'))}/scribe-consent`, { token, body: { method: str(f, 'method') === 'WRITTEN' ? 'WRITTEN' : 'VERBAL' } });
  } catch (e) {
    return back(str(f, 'back'), { error: msg(e, 'Consent not saved.') });
  }
  return back(str(f, 'back'), { ok: 'Consent recorded. You can record or upload the consultation.' });
}

/** Upload the recording, then ask the scribe for a draft (the audio is deleted when the visit is signed). */
export async function uploadRecording(f: FormData) {
  const { accessToken: token } = await actionSession();
  const file = f.get('audio');
  const encounterId = str(f, 'encounterId');
  if (!(file instanceof File) || !file.size) return back(str(f, 'back'), { error: 'Choose a recording first.' });
  try {
    const rec = await api<{ recordingId: string }>(`/api/records/v1/encounters/${encodeURIComponent(encounterId)}/recordings`, {
      token, body: { mimeType: file.type || 'audio/wav', contentBase64: Buffer.from(await file.arrayBuffer()).toString('base64') },
    });
    await api(`/api/assistant/v1/assistant/scribe/encounters/${encodeURIComponent(encounterId)}/drafts`, { token, body: { recordingId: rec.recordingId } });
  } catch (e) {
    return back(str(f, 'back'), { error: msg(e, 'The recording could not be turned into notes.') });
  }
  return back(str(f, 'back'), { ok: 'Draft notes ready below: check every part before using them.' });
}

const ROWS = 8;
/** "Use in visit notes": the doctor's edited draft becomes the visit notes; the prescription form is filled for review. */
export async function applyScribe(f: FormData) {
  const { accessToken: token } = await actionSession();
  const path = str(f, 'back');
  const num = (k: string) => { const v = str(f, k); return v ? Number(v) : undefined; };
  const meds = Array.from({ length: ROWS }, (_, i) => ({ drug: str(f, `drug${i}`), strength: str(f, `strength${i}`), dosage: str(f, `dosage${i}`), durationDays: Number(str(f, `days${i}`) || 0), instructions: str(f, `instr${i}`) })).filter((m) => m.drug);
  const rows = Array.from({ length: 5 }, (_, i) => ({ description: str(f, `dx${i}`), code: str(f, `icd${i}`).toUpperCase(), valid: str(f, `icdValid${i}`) === '1' || str(f, `icd${i}`).toUpperCase() !== str(f, `icdOrig${i}`).toUpperCase() })).filter((d) => d.description);
  const dx = rows.map((d) => ({ description: d.description, ...(d.code ? { icd10Suggestion: d.code } : {}), confidence: 'HIGH' }));
  const labs = str(f, 'labs').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean).map((testCode) => ({ testCode, reason: '' }));
  const vitals = Object.fromEntries(Object.entries({ bp: str(f, 'bp') || undefined, pulse: num('pulse'), tempC: num('tempC'), spo2: num('spo2') }).filter(([, v]) => v !== undefined && !Number.isNaN(v)));
  const final = {
    subjective: str(f, 'subjective'), objective: { vitals, examination: str(f, 'examination') }, assessment: dx,
    plan: { medications: meds, labTests: labs, advice: str(f, 'advice'), ...(num('followUp') ? { followUpInDays: num('followUp') } : {}) }, uncertainties: [],
  };
  const encounterId = str(f, 'encounterId');
  let rx: string;
  try {
    const notes = [final.objective.examination && `Examination: ${final.objective.examination}`, dx.length && `Assessment: ${dx.map((d) => d.description).join('; ')}`, final.plan.advice && `Advice: ${final.plan.advice}`, labs.length && `Tests: ${labs.map((l) => l.testCode).join(', ')}`].filter(Boolean).join('\n');
    await api(`/api/records/v1/encounters/${encodeURIComponent(encounterId)}`, {
      token, method: 'PATCH',
      body: { version: Number(str(f, 'version')), chiefComplaint: final.subjective || undefined, notes, vitals, aiDraftId: str(f, 'draftId'), // a suggested code the ICD-10 list does not have goes in as text; a code the doctor typed is checked by records
        diagnoses: rows.map((d, i) => (d.code && d.valid ? { code: d.code, isPrimary: i === 0 } : { description: d.description, isPrimary: i === 0 })) },
    });
    // only once the notes are saved is the draft marked as used
    await api(`/api/assistant/v1/assistant/scribe/drafts/${encodeURIComponent(str(f, 'draftId'))}/apply`, { token, body: { final } });
    const followUpOn = final.plan.followUpInDays ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + final.plan.followUpInDays * 86_400_000)) : null;
    rx = Buffer.from(JSON.stringify({ items: meds.map((m) => ({ drugName: m.drug, strength: m.strength || null, form: null, dosage: m.dosage || '1-0-1', durationDays: m.durationDays || null, instructions: m.instructions || null })), advice: final.plan.advice || null, followUpOn })).toString('base64url');
  } catch (e) {
    return back(path, { error: msg(e, 'The draft could not be used.') });
  }
  return back(path, { ok: 'Draft taken over into the visit notes. Review the prescription below, then sign the visit.', rx });
}
