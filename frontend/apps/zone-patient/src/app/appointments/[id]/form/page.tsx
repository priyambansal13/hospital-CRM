import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { type FieldDef, FieldInputs, FieldValues, type Values } from '@mc/forms';
import { Alert, Button, Card, PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { type Appointment, fmtDay, fmtTime } from '@/lib/booking';
import { Flash } from '@/lib/flash';
import { answerForm } from '@/lib/form-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface FormView {
  form: { id: string; name: string; intro: string | null; fields: FieldDef[] } | null;
  answers: { formName: string; fields: FieldDef[]; answers: Values; submittedAt: string } | null;
  canAnswer: boolean;
}

/** The hospital's questions before a visit (Phase 27): answer them, or change the answers until the visit starts. */
export default async function VisitForm({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; edit?: string }> }) {
  const { id } = await params;
  const path = `/care/appointments/${id}/form`;
  const caps = await zoneCapabilities('patient', path);
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path={path} zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  const nf = (e: unknown) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e));
  const [a, v] = await Promise.all([
    api<Appointment>(`/api/scheduling/v1/appointments/${encodeURIComponent(id)}`, { token }).catch(nf),
    api<FormView>(`/api/scheduling/v1/appointments/${encodeURIComponent(id)}/form`, { token }).catch(nf),
  ]);
  const sp = await searchParams;
  const fields = v.answers?.fields ?? v.form?.fields ?? [];
  const editing = v.canAnswer && (!v.answers || sp.edit === '1' || !!sp.error);

  return (
    <ZoneFrame zone="patient" path={path} zones={ZONES}>
      <PageHeader title={v.answers?.formName ?? v.form?.name ?? 'Before your visit'} subtitle={`${a.doctor.name} · ${fmtDay(a.localDate, { weekday: 'long', day: 'numeric', month: 'long' })}, ${fmtTime(a.localTime)} · for ${a.patient.name}`} />
      <Flash error={sp.error} />
      {!v.form && !v.answers ? <Card><p className="mc-empty">The hospital has no questions for this visit.</p></Card> : editing ? (
        <Card title={v.answers ? 'Change your answers' : 'A few questions'}>
          {v.form?.intro ? <p className="mc-muted" style={{ marginTop: 0 }}>{v.form.intro}</p> : null}
          <form action={answerForm} className="mc-form" style={{ gridTemplateColumns: '1fr' }}>
            <input type="hidden" name="appointmentId" value={a.id} />
            <FieldInputs defs={fields} values={v.answers?.answers} />
            <Button>Send to the doctor</Button>
          </form>
        </Card>
      ) : (
        <Card title="Your answers">
          <FieldValues defs={fields} values={v.answers!.answers} />
          {v.canAnswer ? <p><a className="mc-btn mc-btn-ghost" href={`${path}?edit=1`}>Change answers</a></p> : <p className="mc-meta">The visit has started, so the answers can no longer change.</p>}
        </Card>
      )}
      <p><a className="mc-btn mc-btn-ghost" href="/care/appointments">My appointments</a></p>
    </ZoneFrame>
  );
}
