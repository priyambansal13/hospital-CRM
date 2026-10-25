import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Button, Card, PageHeader, TextArea } from '@mc/ui';
import { breakGlass } from '@/lib/consult-actions';
import { AllergyPanel, DocumentsPanel, loadAllergies } from '@/lib/clinical-panels';
import { EncounterCard } from '@/lib/encounter-view';
import { Flash } from '@/lib/flash';
import { type Chart, time } from '@/lib/records';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** A patient's clinical record. No treating relationship → refusal with the break-glass option (reason required). */
export default async function PatientChart({ params, searchParams }: { params: Promise<{ patientId: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { patientId } = await params;
  const path = `/doctor/patients/${patientId}`;
  const caps = await zoneCapabilities('doctor', path);
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  let chart: Chart | null = null;
  let refusal: ApiError | null = null;
  try {
    chart = await api<Chart>(`/api/records/v1/patients/${encodeURIComponent(patientId)}/chart`, { token });
  } catch (e) {
    if (!(e instanceof ApiError) || ![403, 404].includes(e.status)) throw e;
    refusal = e;
  }
  return (
    <ZoneFrame zone="doctor" path={path} zones={ZONES}>
      <PageHeader title={chart ? chart.patient.name : 'Patient record'} subtitle={chart ? `${chart.patient.mrn} · ${chart.patient.age ?? '?'} y${chart.patient.gender ? ` · ${chart.patient.gender.toLowerCase()}` : ''}` : undefined} actions={<a className="mc-btn mc-btn-ghost" href="/doctor/patients">Find another</a>} />
      <Flash ok={sp.ok} error={sp.error} />
      {refusal ? (
        <>
          <Alert tone="error">{refusal.status === 404 ? 'No such patient.' : refusal.message}</Alert>
          {refusal.problem.breakGlassAvailable && can(caps, 'record:break_glass:tenant') ? (
            <Card title="Emergency access (break-glass)">
              <p className="mc-muted" style={{ marginTop: 0 }}>Opens this record for 4 hours. Your name, the time and your reason are recorded, shown to the patient and reviewed by the hospital.</p>
              <form action={breakGlass} className="mc-form" style={{ gridTemplateColumns: '1fr' }}>
                <input type="hidden" name="patientId" value={patientId} /><input type="hidden" name="back" value={path} />
                <TextArea label="Reason" name="reason" rows={2} maxLength={300} placeholder="e.g. patient unconscious in emergency, need medication history" />
                <Button variant="danger">Open with emergency access</Button>
              </form>
            </Card>
          ) : null}
        </>
      ) : chart ? (
        <>
          {chart.access.purpose === 'BREAK_GLASS' ? <Alert tone="error">Emergency access until {chart.access.breakGlassUntil ? time(chart.access.breakGlassUntil) : '—'}. Everything you open is recorded.</Alert> : null}
          {chart.access.purpose === 'CONSENT' ? <Alert tone="info">Shared with you by the patient.</Alert> : null}
          <AllergyPanel allergies={await loadAllergies(token, patientId)} patientId={patientId} back={path} canAdd={chart.access.purpose === 'TREATMENT'} />
          <DocumentsPanel token={token} patientId={patientId} />
          {chart.encounters.length ? chart.encounters.map((e) => <EncounterCard key={e.id} e={e} />) : <Card><p className="mc-empty">No visits recorded yet.</p></Card>}
        </>
      ) : null}
    </ZoneFrame>
  );
}
