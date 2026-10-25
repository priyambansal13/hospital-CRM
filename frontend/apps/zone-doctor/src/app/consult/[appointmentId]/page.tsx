import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, Field, PageHeader, TextArea } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { addDiagnosis, amendVisit, orderLabTests, finishVisit, issuePrescription, makePrimary, removeDiagnosis, saveDraft, signVisit, startVisit } from '@/lib/consult-actions';
import { AllergyPanel, DocumentsPanel, loadAllergies } from '@/lib/clinical-panels';
import { EncounterCard } from '@/lib/encounter-view';
import { Flash } from '@/lib/flash';
import { finishSignLater } from '@/lib/visit-actions';
import { type Chart, type Encounter } from '@/lib/records';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Appt { id: string; appointmentNo: string; status: string; tokenNo: number | null; mode: string; reason: string | null; localTime: string; patient: { id: string; name: string; mrn: string } }

const Hidden = ({ e, back }: { e: Encounter; back: string }) => (
  <><input type="hidden" name="encounterId" value={e.id} /><input type="hidden" name="version" value={e.version} /><input type="hidden" name="back" value={back} /></>
);

/** The consultation: notes, diagnoses (ICD-10), sign, prescription — for the appointment in front of the doctor. */
export default async function Consult({ params, searchParams }: { params: Promise<{ appointmentId: string }>; searchParams: Promise<{ ok?: string; error?: string; icd?: string; unsigned?: string; allergy?: string; rx?: string }> }) {
  const { appointmentId } = await params;
  const path = `/doctor/consult/${appointmentId}`;
  await zoneCapabilities('doctor', path);
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const appt = await api<Appt>(`/api/scheduling/v1/appointments/${encodeURIComponent(appointmentId)}`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  const enc = await api<Encounter>(`/api/records/v1/encounters/by-appointment/${appointmentId}`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
  const chart = enc ? await api<Chart>(`/api/records/v1/patients/${enc.patient.id}/chart`, { token }).catch(() => null) : null;
  const icd = enc && sp.icd ? await api<{ code: string; title: string }[]>(`/api/records/v1/icd10?q=${encodeURIComponent(sp.icd)}`, { token }) : [];
  const open = enc?.status === 'OPEN';
  const allergies = enc ? await loadAllergies(token, enc.patient.id) : null;
  const labCatalog = enc ? await api<{ packages: { id: string; name: string; price: number }[]; tests: { id: string; name: string; category: string }[] }>('/api/diagnostics/v1/public/lab-catalog', { token }).catch(() => null) : null;
  const p = enc?.patient;
  // a prescription sent back because of an allergy clash: refill the form (review C-3)
  let rx: { items: { drugName: string; strength: string | null; form: string | null; dosage: string; durationDays: number | null; instructions: string | null }[]; advice: string | null; followUpOn: string | null } | null = null;
  try { rx = sp.rx ? JSON.parse(Buffer.from(sp.rx, 'base64url').toString()) : null; } catch { rx = null; }
  const rxRow = (i: number) => rx?.items[i];

  return (
    <ZoneFrame zone="doctor" path={path} zones={ZONES}>
      <PageHeader
        title={p ? `${p.name}` : appt.patient.name}
        subtitle={`${appt.patient.mrn}${p ? ` · ${p.age ?? '?'} y${p.gender ? ` · ${p.gender.toLowerCase()}` : ''}` : ''} · ${appt.appointmentNo}${appt.tokenNo ? ` · token ${appt.tokenNo}` : ''}${appt.reason ? ` · "${appt.reason}"` : ''}`}
        actions={<a className="mc-btn mc-btn-ghost" href="/doctor/queue">Back to queue</a>}
      />
      <Flash ok={sp.ok} error={sp.error} />
      {!enc ? (
        <Card title="Start the visit notes">
          <form action={startVisit}>
            <input type="hidden" name="appointmentId" value={appointmentId} /><input type="hidden" name="back" value={path} />
            <Button>Start visit</Button>
          </form>
        </Card>
      ) : (
        <>
          <Card title={`Visit · ${enc.status.toLowerCase()}`}>
            <form action={saveDraft} className="mc-form">
              <Hidden e={enc} back={path} />
              <Field label="BP (mmHg)" name="bp" defaultValue={enc.vitals.bp ?? ''} placeholder="120/80" />
              <Field label="Pulse (/min)" name="pulse" type="number" defaultValue={enc.vitals.pulse?.toString() ?? ''} />
              <Field label="Temp (°C)" name="tempC" defaultValue={enc.vitals.tempC?.toString() ?? ''} inputMode="numeric" />
              <Field label="SpO₂ (%)" name="spo2" type="number" defaultValue={enc.vitals.spo2?.toString() ?? ''} />
              <Field label="Weight (kg)" name="weightKg" defaultValue={enc.vitals.weightKg?.toString() ?? ''} inputMode="numeric" />
              <TextArea label="Chief complaint" name="chiefComplaint" rows={2} defaultValue={enc.chiefComplaint ?? ''} maxLength={500} />
              <TextArea label="Clinical notes" name="notes" rows={6} defaultValue={enc.notes ?? ''} maxLength={10000} />
              {open ? <Button>Save draft</Button> : <small className="mc-muted mc-field-wide">Signed {enc.signedAt ? new Date(enc.signedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : ''}. Corrections are added as amendments below.</small>}
            </form>
          </Card>

          <Card title="Diagnosis">
            {enc.diagnoses.length ? (
              <ul className="mc-queue" aria-label="Diagnoses">
                {enc.diagnoses.map((d, i) => (
                  <li key={`${d.code}-${i}`} className="mc-queue-item">
                    <span className="mc-token mc-token-none">{d.code ?? '—'}</span>
                    <div><strong>{d.description}</strong>{d.isPrimary ? <Badge tone="success">primary</Badge> : null}</div>
                    {open ? (
                      <div className="mc-inline">
                        {!d.isPrimary ? <form action={makePrimary} className="mc-inline"><Hidden e={enc} back={path} /><input type="hidden" name="index" value={i} /><Button variant="ghost">Make primary</Button></form> : null}
                        <form action={removeDiagnosis} className="mc-inline"><Hidden e={enc} back={path} /><input type="hidden" name="index" value={i} /><Button variant="ghost">Remove</Button></form>
                      </div>
                    ) : <span />}
                  </li>
                ))}
              </ul>
            ) : <p className="mc-empty">No diagnosis yet.</p>}
            {open ? (
              <>
                <form method="get" className="mc-form" style={{ marginTop: 12 }}>
                  <Field label="Search ICD-10" name="icd" defaultValue={sp.icd ?? ''} placeholder="diabetes, J06, fever…" />
                  <Button variant="ghost">Search</Button>
                </form>
                {icd.length ? (
                  <ul className="mc-queue" aria-label="ICD-10 results" style={{ marginTop: 8 }}>
                    {icd.map((c) => (
                      <li key={c.code} className="mc-queue-item">
                        <span className="mc-token mc-token-none">{c.code}</span><span>{c.title}</span>
                        <form action={addDiagnosis} className="mc-inline"><Hidden e={enc} back={`${path}`} /><input type="hidden" name="code" value={c.code} /><Button variant="ghost">{`Add ${c.code}`}</Button></form>
                      </li>
                    ))}
                  </ul>
                ) : sp.icd ? <p className="mc-muted">No ICD-10 match. Add it as free text:</p> : null}
                {sp.icd && !icd.length ? (
                  <form action={addDiagnosis} className="mc-form"><Hidden e={enc} back={path} /><Field label="Diagnosis (free text)" name="description" defaultValue={sp.icd} /><Button variant="ghost">Add</Button></form>
                ) : null}
              </>
            ) : null}
          </Card>

          {open ? (
            <Card title="Sign the visit">
              <p className="mc-muted" style={{ marginTop: 0 }}>Signing locks the notes. Later corrections become amendments with a reason.</p>
              <form action={signVisit}><Hidden e={enc} back={path} /><Button>Sign visit</Button></form>
            </Card>
          ) : (
            <Card title="Amend">
              <form action={amendVisit} className="mc-form">
                <Hidden e={enc} back={path} />
                <Field label="Reason for the amendment" name="reason" required placeholder="e.g. lab result added" />
                <TextArea label="Corrected notes" name="notes" rows={4} defaultValue={enc.notes ?? ''} />
                <Button variant="ghost">Save amendment</Button>
              </form>
              {enc.amendments.map((a, i) => <p key={i} className="mc-meta">{new Date(a.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}: {a.reason} ({a.changed.join(', ')})</p>)}
            </Card>
          )}

          <AllergyPanel allergies={allergies} patientId={enc.patient.id} back={path} canAdd />

          <Card title="Prescription">
            {enc.prescriptions.map((rx) => (
              <p key={rx.id}><strong>{rx.prescriptionNo}</strong>: {rx.items.map((i) => `${i.drugName}${i.strength ? ` ${i.strength}` : ''} ${i.dosage}${i.durationDays ? ` × ${i.durationDays}d` : ''}`).join(', ')} · <a href={`/doctor/prescriptions/${rx.id}/pdf`}>PDF</a></p>
            ))}
            <form action={issuePrescription} className="mc-form" aria-label="New prescription">
              <Hidden e={enc} back={path} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <div className="mc-table-wrap mc-field-wide">
                <table className="mc-table">
                  <thead><tr><th>Medicine</th><th>Strength</th><th>Form</th><th>Dosage</th><th>Days</th><th>Instructions</th></tr></thead>
                  <tbody>
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                      <tr key={i}>
                        <td><input name={`drug${i}`} aria-label={`Medicine ${i + 1}`} className="mc-input-sm" style={{ width: '100%' }} defaultValue={rxRow(i)?.drugName ?? ''} /></td>
                        <td><input name={`strength${i}`} aria-label={`Strength ${i + 1}`} className="mc-input-sm" placeholder="500 mg" defaultValue={rxRow(i)?.strength ?? ''} /></td>
                        <td><input name={`form${i}`} aria-label={`Form ${i + 1}`} className="mc-input-sm" placeholder="tablet" defaultValue={rxRow(i)?.form ?? ''} /></td>
                        <td><input name={`dosage${i}`} aria-label={`Dosage ${i + 1}`} className="mc-input-sm" placeholder="1-0-1" defaultValue={rxRow(i)?.dosage ?? ''} /></td>
                        <td><input name={`days${i}`} aria-label={`Days ${i + 1}`} type="number" min={1} max={365} className="mc-input-sm" style={{ width: 64 }} defaultValue={rxRow(i)?.durationDays ?? ''} /></td>
                        <td><input name={`instr${i}`} aria-label={`Instructions ${i + 1}`} className="mc-input-sm" placeholder="after food" defaultValue={rxRow(i)?.instructions ?? ''} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TextArea label="Advice" name="advice" rows={2} maxLength={2000} defaultValue={rx?.advice ?? undefined} />
              <Field label="Follow up on" name="followUpOn" type="date" defaultValue={rx?.followUpOn ?? undefined} />
              {sp.allergy ? (
                <div className="mc-field-wide">
                  <Alert tone="error">This prescription clashes with a recorded allergy (or allergies could not be checked). Change the medicine, or give your reason; it is recorded.</Alert>
                  <TextArea label="Reason to prescribe despite the allergy" name="allergyOverride" rows={2} maxLength={300} />
                </div>
              ) : null}
              <Button>Issue prescription</Button>
            </form>
          </Card>

          {labCatalog ? (
            <Card title="Order lab tests">
              <form action={orderLabTests} className="mc-form" aria-label="Order lab tests" style={{ gridTemplateColumns: '1fr' }}>
                <input type="hidden" name="patientId" value={enc.patient.id} /><input type="hidden" name="encounterId" value={enc.id} />
                <input type="hidden" name="back" value={path} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <div className="mc-checks">
                  {labCatalog.packages.map((p) => <label key={p.id} className="mc-check"><input type="checkbox" name="pkg" value={p.id} /><span>{p.name} (package)</span></label>)}
                  {labCatalog.tests.map((t) => <label key={t.id} className="mc-check"><input type="checkbox" name="test" value={t.id} /><span>{t.name}</span></label>)}
                </div>
                <TextArea label="Note to the lab (optional)" name="note" rows={2} maxLength={300} />
                <Button variant="ghost">Order tests</Button>
              </form>
            </Card>
          ) : null}

          {appt.status === 'IN_PROGRESS' ? (
            <Card>
              <form action={finishVisit}><input type="hidden" name="appointmentId" value={appt.id} /><input type="hidden" name="back" value={path} /><Button>Finish visit</Button></form>
              {sp.unsigned ? (
                <form action={finishSignLater} style={{ marginTop: 8 }}>
                  <input type="hidden" name="id" value={appt.id} />
                  <p className="mc-meta" style={{ margin: '0 0 6px' }}>The note isn&apos;t signed. Sign it above, or finish now and sign it later from &quot;Unsigned notes&quot;.</p>
                  <Button variant="ghost">Finish, sign the note later</Button>
                </form>
              ) : null}
            </Card>
          ) : null}

          <DocumentsPanel token={token} patientId={enc.patient.id} />
          <h2 className="mc-section-title">Previous visits</h2>
          {chart ? (
            chart.encounters.filter((e) => e.id !== enc.id).length
              ? chart.encounters.filter((e) => e.id !== enc.id).map((e) => <EncounterCard key={e.id} e={e} />)
              : <p className="mc-empty">First visit with this hospital.</p>
          ) : <Alert tone="error">History could not be loaded.</Alert>}
        </>
      )}
    </ZoneFrame>
  );
}
