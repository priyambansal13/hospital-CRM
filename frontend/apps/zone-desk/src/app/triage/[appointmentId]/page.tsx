import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Button, Card, Field, PageHeader, Select, TextArea } from '@mc/ui';
import { notFound } from 'next/navigation';
import { recordTriage } from '@/lib/actions';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Triage { priority: string; vitals: Record<string, string | number>; chiefComplaint: string | null; recordedBy: string | null; recordedAt: string; version: number }
interface Appointment { id: string; status: string; patient: { name: string; mrn: string }; doctor: { name: string }; tokenNo: number | null }

/** Nurse: vitals, how urgent, and the complaint, before the doctor calls the patient in. Copied into the doctor's note. */
export default async function TriagePage({ params, searchParams }: { params: Promise<{ appointmentId: string }>; searchParams: Promise<{ back?: string; ok?: string; error?: string }> }) {
  const { appointmentId } = await params;
  const sp = await searchParams;
  const caps = await zoneCapabilities('desk', '/desk');
  if (!can(caps, 'vitals:record:branch')) notFound();
  const { accessToken: token } = (await getSession())!;
  const missing = (e: unknown) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e));
  const [a, t] = await Promise.all([
    api<Appointment>(`/api/scheduling/v1/appointments/${appointmentId}`, { token }).catch(missing),
    api<{ triage: Triage | null }>(`/api/records/v1/appointments/${appointmentId}/triage`, { token }).catch(missing),
  ]);
  if (!a) notFound();
  const v = t?.triage?.vitals ?? {};
  const back = sp.back?.startsWith('/desk') ? sp.back : '/desk';
  const val = (k: string) => (v[k] == null ? undefined : String(v[k]));
  return (
    <ZoneFrame zone="desk" path="/desk" zones={ZONES}>
      <PageHeader title={`Vitals: ${a.patient.name}`} subtitle={`${a.patient.mrn} · for ${a.doctor.name}${a.tokenNo ? ` · token ${a.tokenNo}` : ''}`} actions={<a href={back}>Back to the desk</a>} />
      <Flash ok={sp.ok} error={sp.error} />
      {a.status !== 'CHECKED_IN' ? <Alert>{a.status === 'IN_PROGRESS' ? 'The doctor has started the visit and records vitals in the note now.' : 'Vitals are recorded once the patient has checked in.'}</Alert> : null}
      {t?.triage ? <Alert tone="success">Recorded by {t.triage.recordedBy ?? 'a nurse'}; saving again replaces it.</Alert> : null}
      <Card>
        <form action={recordTriage} className="mc-form">
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <input type="hidden" name="back" value={back} />
          {t?.triage ? <input type="hidden" name="version" value={t.triage.version} /> : null}
          <Select label="Priority" name="priority" defaultValue={t?.triage?.priority ?? 'ROUTINE'} options={[
            { value: 'ROUTINE', label: 'Routine' }, { value: 'URGENT', label: 'Urgent: should be seen next' }, { value: 'EMERGENCY', label: 'Emergency: tell the doctor now' },
          ]} />
          <Field label="Blood pressure" name="bp" placeholder="120/80" defaultValue={val('bp')} pattern="\d{2,3}/\d{2,3}" />
          <Field label="Pulse (per minute)" name="pulse" inputMode="numeric" defaultValue={val('pulse')} />
          <Field label="Temperature (°C)" name="tempC" inputMode="decimal" defaultValue={val('tempC')} />
          <Field label="SpO₂ (%)" name="spo2" inputMode="numeric" defaultValue={val('spo2')} />
          <Field label="Breathing rate (per minute)" name="respRate" inputMode="numeric" defaultValue={val('respRate')} />
          <Field label="Weight (kg)" name="weightKg" inputMode="decimal" defaultValue={val('weightKg')} />
          <Field label="Height (cm)" name="heightCm" inputMode="decimal" defaultValue={val('heightCm')} />
          <TextArea label="Complaint (in the patient's words)" name="chiefComplaint" maxLength={500} defaultValue={t?.triage?.chiefComplaint ?? undefined} />
          <Button>Save vitals</Button>
        </form>
      </Card>
    </ZoneFrame>
  );
}
