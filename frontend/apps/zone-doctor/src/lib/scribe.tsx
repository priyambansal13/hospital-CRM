import { api } from '@mc/bff';
import { Alert, Badge, Button, Card, Field, Select, TextArea } from '@mc/ui';
import { applyScribe, recordConsent, uploadRecording } from './scribe-actions';

interface Soap {
  subjective: string; objective: { vitals: { bp?: string; pulse?: number; tempC?: number; spo2?: number }; examination: string };
  assessment: { description: string; icd10Suggestion?: string; confidence: string }[];
  plan: { medications: { drug: string; strength: string; dosage: string; durationDays: number; instructions: string }[]; labTests: { testCode: string }[]; advice: string; followUpInDays?: number };
  uncertainties: string[];
}
interface Draft {
  id: string; status: 'DRAFT' | 'APPLIED'; createdAt: string; model: string | null; transcript: string; soap: Soap; edited: boolean | null;
  checks: {
    medicines: { drug: string; formulary: string | null }[]; labTests: { testCode: string; name: string | null }[]; icd10: { code: string; valid: boolean }[];
    safety: { allergies: { drug: string; allergy: string; level: string; reason: string }[]; interactions: { a: string; b: string; severity: string; effect: string; withCurrent: boolean }[]; duplicates: { a: string; b: string; drugClass: string }[]; allergiesChecked: boolean } | null;
  };
}
interface Enc { id: string; version: number; status: string; scribeConsent: { at: string; method: string } | null }

const ROWS = 8;

/**
 * The AI scribe (Phase 25): with the patient's consent, a recording of the consultation becomes a draft of the notes
 * and the prescription. Everything is shown with what it was checked against; the doctor edits, takes it over into
 * the visit notes, reviews the prescription and signs. The recording is deleted when the visit is signed.
 */
export async function ScribePanel({ token, enc, back }: { token: string; enc: Enc; back: string }) {
  if (enc.status !== 'OPEN') return null;
  const { draft: d } = await api<{ draft: Draft | null }>(`/api/assistant/v1/assistant/scribe/encounters/${enc.id}/draft`, { token }).catch(() => ({ draft: null }));
  const hidden = <><input type="hidden" name="encounterId" value={enc.id} /><input type="hidden" name="back" value={back} /></>;
  return (
    <Card title="AI scribe">
      <p className="mc-meta" style={{ marginTop: 0 }}>Turns a recording of this consultation into draft notes and a draft prescription. Nothing is saved to the visit until you take it over; the recording is deleted when you sign.</p>
      {!enc.scribeConsent ? (
        <form action={recordConsent} className="mc-form">
          {hidden}
          <Select label="The patient agreed to recording" name="method" options={[{ value: 'VERBAL', label: 'Verbally' }, { value: 'WRITTEN', label: 'In writing' }]} />
          <Button variant="ghost">Record consent</Button>
        </form>
      ) : !d || d.status !== 'DRAFT' ? (
        <>
          {d?.status === 'APPLIED' ? <Alert tone="success">Draft taken over into the visit notes{d.edited ? ' (with your changes)' : ''}. Review the prescription, then sign.</Alert> : null}
          <form action={uploadRecording} className="mc-form">
            {hidden}
            <p className="mc-meta">Consent: {enc.scribeConsent.method.toLowerCase()}, {new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(enc.scribeConsent.at))}</p>
            <label className="mc-field"><span>Consultation recording (wav, webm, ogg, mp3 or m4a, up to 10 MB)</span><input type="file" name="audio" accept="audio/*" required /></label>
            <Button variant={d ? 'ghost' : 'primary'}>Make draft notes</Button>
          </form>
        </>
      ) : (
        <DraftForm d={d} enc={enc} back={back} />
      )}
    </Card>
  );
}

function DraftForm({ d, enc, back }: { d: Draft; enc: Enc; back: string }) {
  const s = d.soap;
  const safety = d.checks.safety;
  const med = (i: number) => s.plan.medications[i];
  return (
    <form action={applyScribe} className="mc-form mc-scribe" aria-label="Draft notes">
      <input type="hidden" name="encounterId" value={enc.id} /><input type="hidden" name="version" value={enc.version} /><input type="hidden" name="draftId" value={d.id} /><input type="hidden" name="back" value={back} />
      {safety?.allergies.length || safety?.interactions.length || safety?.duplicates.length ? (
        <Alert tone="error">
          <strong>Prescription safety (from the drug rules, not the AI):</strong>
          <ul>
            {safety.allergies.map((a, i) => <li key={`a${i}`}>{a.level === 'BLOCK' ? 'Allergy' : 'Caution'}: {a.drug} vs recorded {a.allergy} ({a.reason})</li>)}
            {safety.interactions.map((x, i) => <li key={`x${i}`}>{x.severity === 'MAJOR' ? 'Major' : 'Moderate'} interaction: {x.a} + {x.b}{x.withCurrent ? ' (taken now)' : ''}: {x.effect}</li>)}
            {safety.duplicates.map((x, i) => <li key={`d${i}`}>Same class twice ({x.drugClass.toLowerCase()}): {x.a}, {x.b}</li>)}
          </ul>
        </Alert>
      ) : null}
      {s.uncertainties.length ? <Alert tone="info">Check: {s.uncertainties.join('; ')}</Alert> : null}
      <TextArea label="Subjective (complaint, history)" name="subjective" defaultValue={s.subjective} rows={3} />
      <div className="mc-row">
        <Field label="BP" name="bp" defaultValue={s.objective.vitals.bp ?? ''} />
        <Field label="Pulse" name="pulse" defaultValue={s.objective.vitals.pulse?.toString() ?? ''} />
        <Field label="Temp °C" name="tempC" defaultValue={s.objective.vitals.tempC?.toString() ?? ''} />
        <Field label="SpO2 %" name="spo2" defaultValue={s.objective.vitals.spo2?.toString() ?? ''} />
      </div>
      <TextArea label="Examination" name="examination" defaultValue={s.objective.examination} rows={2} />
      <fieldset><legend>Assessment</legend>
        {Array.from({ length: 5 }, (_, i) => s.assessment[i] ?? (i < s.assessment.length + 1 ? { description: '', confidence: '' } : null)).map((a, i) => a === null ? null : (
          <div key={i} className="mc-row">
            <Field label={`Diagnosis ${i + 1}`} name={`dx${i}`} defaultValue={a.description} />
            <Field label="ICD-10" name={`icd${i}`} defaultValue={a.icd10Suggestion ?? ''} />
            <input type="hidden" name={`icdOrig${i}`} value={a.icd10Suggestion ?? ''} />
            <input type="hidden" name={`icdValid${i}`} value={d.checks.icd10.find((c) => c.code === a.icd10Suggestion)?.valid ? '1' : '0'} />
            {a.icd10Suggestion ? <Badge tone={d.checks.icd10.find((c) => c.code === a.icd10Suggestion)?.valid ? 'success' : 'warning'}>{d.checks.icd10.find((c) => c.code === a.icd10Suggestion)?.valid ? 'code found' : 'code not in the list'}</Badge> : null}
          </div>
        ))}
      </fieldset>
      <fieldset><legend>Prescription (draft)</legend>
        {Array.from({ length: ROWS }, (_, i) => i).filter((i) => i <= s.plan.medications.length).map((i) => (
          <div key={i} className="mc-row" data-unmatched={med(i) && !d.checks.medicines[i]?.formulary ? 'true' : undefined}>
            <Field label="Medicine" name={`drug${i}`} defaultValue={med(i)?.drug ?? ''} />
            <Field label="Strength" name={`strength${i}`} defaultValue={med(i)?.strength ?? ''} />
            <Field label="Dosage" name={`dosage${i}`} defaultValue={med(i)?.dosage ?? ''} />
            <Field label="Days" name={`days${i}`} defaultValue={med(i)?.durationDays ? String(med(i).durationDays) : ''} />
            <Field label="Instructions" name={`instr${i}`} defaultValue={med(i)?.instructions ?? ''} />
            {med(i) ? <Badge tone={d.checks.medicines[i]?.formulary ? 'success' : 'warning'}>{d.checks.medicines[i]?.formulary ? `formulary: ${d.checks.medicines[i].formulary}` : 'not in the formulary'}</Badge> : null}
          </div>
        ))}
      </fieldset>
      <Field label="Lab tests (codes, comma separated)" name="labs" defaultValue={s.plan.labTests.map((l) => l.testCode).join(', ')} />
      <p className="mc-meta">{d.checks.labTests.map((l) => `${l.testCode}: ${l.name ?? 'not in the test catalog'}`).join(' · ')}{d.checks.labTests.length ? ' (order them with "Order lab tests")' : ''}</p>
      <TextArea label="Advice" name="advice" defaultValue={s.plan.advice} rows={2} />
      <Field label="Follow-up in (days)" name="followUp" defaultValue={s.plan.followUpInDays ? String(s.plan.followUpInDays) : ''} />
      <details><summary>Transcript</summary><pre className="mc-transcript">{d.transcript}</pre></details>
      <Button>Use in visit notes</Button>
    </form>
  );
}
