import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { type FieldDef, FieldInputs, FieldValues, type Values } from '@mc/forms';
import { Alert, Badge, Button, Card, PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { age, type Appt, type Patient, STATUS } from '@/lib/desk';
import { saveCustomFields } from '@/lib/field-actions';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

type StaffPatient = Patient & { customFields: Values; tags: string[]; version: number };
type StaffAppt = Appt & { customFields: Values; version: number; formAnswers: { formName: string; fields: FieldDef[]; answers: Values } | null };

/** One patient at the desk: the hospital's custom fields on them and on their visits, workflow tags (Phase 27). */
export default async function DeskPatient({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const path = `/desk/patients/${id}`;
  const caps = await zoneCapabilities('desk', path);
  if (!caps.modules.includes('workflows') || !caps.permissions.includes('custom_field:write:branch')) {
    return <ZoneFrame zone="desk" path={path} zones={ZONES}><Alert tone="info">Custom fields are not switched on for this hospital.</Alert></ZoneFrame>;
  }
  const { accessToken: token } = (await getSession())!;
  const p = await api<StaffPatient>(`/api/patient/v1/desk/patients/${encodeURIComponent(id)}`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  const [patientDefs, apptDefs, appts] = await Promise.all([
    api<FieldDef[]>('/api/integration/v1/custom-fields/active?entity=PATIENT', { token }),
    api<FieldDef[]>('/api/integration/v1/custom-fields/active?entity=APPOINTMENT', { token }),
    api<StaffAppt[]>(`/api/scheduling/v1/appointments/of-patient/${encodeURIComponent(id)}`, { token }).catch(() => []),
  ]);
  const sp = await searchParams;

  return (
    <ZoneFrame zone="desk" path={path} zones={ZONES}>
      <PageHeader title={p.fullName} subtitle={`${p.mrn} · ${age(p.dob)} y${p.gender ? ` · ${p.gender[0]}` : ''} · ${p.phone ?? 'no mobile'}`} actions={<a className="mc-btn mc-btn-primary" href={`/desk/book?patientId=${p.id}`}>Book visit</a>} />
      <Flash ok={sp.ok} error={sp.error} />
      {p.tags.length ? <p aria-label="Tags">{p.tags.map((t) => <Badge key={t} tone="warning">{t}</Badge>)}</p> : null}
      <Card title="Patient details">
        {patientDefs.length ? (
          <form action={saveCustomFields} className="mc-form">
            <input type="hidden" name="patientId" value={p.id} /><input type="hidden" name="version" value={p.version} />
            <FieldInputs defs={patientDefs} values={p.customFields} />
            <Button>Save details</Button>
          </form>
        ) : <p className="mc-empty">The hospital has no custom patient fields. An admin adds them under Custom fields and forms.</p>}
      </Card>
      <Card title="Visits (last 30 days and coming)">
        {appts.length ? appts.map((a) => (
          <details key={a.id} className="mc-details" open={appts.length === 1}>
            <summary><strong>{a.appointmentNo}</strong> · {a.localDate} {a.localTime} · {a.doctor.name} · <Badge tone={STATUS[a.status]?.tone ?? 'neutral'}>{STATUS[a.status]?.label ?? a.status.toLowerCase()}</Badge></summary>
            {apptDefs.length ? (
              <form action={saveCustomFields} className="mc-form" aria-label={`Fields for ${a.appointmentNo}`}>
                <input type="hidden" name="patientId" value={p.id} /><input type="hidden" name="appointmentId" value={a.id} /><input type="hidden" name="version" value={a.version} />
                <FieldInputs defs={apptDefs} values={a.customFields} />
                <Button>Save</Button>
              </form>
            ) : null}
            {a.formAnswers ? <><h4 style={{ margin: '12px 0 4px' }}>{a.formAnswers.formName} (answered by the patient)</h4><FieldValues defs={a.formAnswers.fields} values={a.formAnswers.answers} /></> : null}
          </details>
        )) : <p className="mc-empty">No recent or coming visits.</p>}
      </Card>
    </ZoneFrame>
  );
}
