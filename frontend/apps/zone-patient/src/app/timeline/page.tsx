import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, Chip, Field, PageHeader, Select } from '@mc/ui';
import { myPatients } from '@/lib/booking';
import { Flash } from '@/lib/flash';
import { addAllergy, registerUpload, removeAllergy, removeDocument, requestUpload } from '@/lib/health-actions';
import { UploadForm } from '@/lib/upload-form';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Item { id: string; kind: string; refId: string; occurredAt: string; title: string; summary: Record<string, any>; doctor: string | null }
interface Doc { id: string; title: string; type: string; scanStatus: string; scanDetail: string | null; issuedOn: string | null; createdAt: string; uploadedBy: { kind: string; name: string | null } }
interface Allergy { id: string; substance: string; severity: string; reaction: string | null; recordedBy: { kind: string; name: string | null } }

const day = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
const KIND: Record<string, string> = { APPOINTMENT: 'Appointment', ENCOUNTER: 'Visit', PRESCRIPTION: 'Prescription', DOCUMENT: 'Document', REPORT: 'Report', LAB_ORDER: 'Lab test' };

/** One place for a patient's health story: allergies, their documents, and the timeline of visits and results. */
export default async function Timeline({ searchParams }: { searchParams: Promise<{ patientId?: string; beforeAt?: string; beforeId?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('patient', '/care/timeline');
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path="/care/timeline" zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const family = await myPatients(token);
  const p = family.find((x) => x.id === sp.patientId) ?? family.find((x) => x.isSelf) ?? family[0];
  if (!p) return <ZoneFrame zone="patient" path="/care/timeline" zones={ZONES}><Card><p>Complete <a href="/care/profile">your profile</a> first.</p></Card></ZoneFrame>;
  const [tl, docs, allergies] = await Promise.all([
    // E-7: older entries, 30 at a time
    api<{ items: Item[]; next: { at: string; id: string } | null }>(`/api/records/v1/patients/${p.id}/timeline${sp.beforeAt && sp.beforeId ? `?${new URLSearchParams({ beforeAt: sp.beforeAt, beforeId: sp.beforeId })}` : ''}`, { token }),
    api<Doc[]>(`/api/records/v1/patients/${p.id}/documents`, { token }),
    api<Allergy[]>(`/api/patient/v1/me/patients/${p.id}/allergies`, { token }),
  ]);
  const checking = docs.filter((d) => d.scanStatus === 'PENDING' || d.scanStatus === 'SCANNING');
  const refused = docs.filter((d) => d.scanStatus === 'INFECTED' || d.scanStatus === 'REJECTED');
  const path = `/care/timeline?patientId=${p.id}`;
  return (
    <ZoneFrame zone="patient" path="/care/timeline" zones={ZONES}>
      {checking.length ? <meta httpEquiv="refresh" content="3" /> : null}
      <PageHeader title="Health record" subtitle={`${p.fullName} · ${p.mrn}`} actions={<a className="mc-btn mc-btn-ghost" href={`/care/sharing?patientId=${p.id}`}>Share with a doctor</a>} />
      {family.length > 1 ? <div className="mc-chips">{family.map((x) => <Chip key={x.id} href={`/care/timeline?patientId=${x.id}`} active={x.id === p.id}>{x.fullName}</Chip>)}</div> : null}
      <Flash ok={sp.ok} error={sp.error} />

      <Card title="Allergies">
        {allergies.length ? (
          <ul className="mc-queue" aria-label="Allergies">
            {allergies.map((a) => (
              <li key={a.id} className="mc-queue-item">
                <Badge tone={a.severity === 'SEVERE' ? 'danger' : a.severity === 'MODERATE' ? 'warning' : 'neutral'}>{a.severity.toLowerCase()}</Badge>
                <div><strong>{a.substance}</strong><span className="mc-meta">{a.reaction ? ` · ${a.reaction}` : ''}{a.recordedBy.kind === 'staff' ? ` · recorded by ${a.recordedBy.name ?? 'the hospital'}` : ''}</span></div>
                {a.recordedBy.kind === 'patient' ? (
                  <form action={removeAllergy} className="mc-inline"><input type="hidden" name="patientId" value={p.id} /><input type="hidden" name="allergyId" value={a.id} /><Button variant="ghost">Remove</Button></form>
                ) : <span />}
              </li>
            ))}
          </ul>
        ) : <p className="mc-empty">No allergies recorded.</p>}
        <form action={addAllergy} className="mc-form" style={{ marginTop: 12 }}>
          <input type="hidden" name="patientId" value={p.id} />
          <Field label="Allergic to" name="substance" required placeholder="e.g. Penicillin, peanuts" />
          <Select label="Severity" name="severity" options={[{ value: 'UNKNOWN', label: 'Not sure' }, { value: 'MILD', label: 'Mild' }, { value: 'MODERATE', label: 'Moderate' }, { value: 'SEVERE', label: 'Severe' }]} />
          <Field label="Reaction (optional)" name="reaction" placeholder="e.g. rash, swelling" />
          <Button variant="ghost">Add allergy</Button>
        </form>
      </Card>

      <Card title="Add a report or document">
        <UploadForm patientId={p.id} request={requestUpload} register={registerUpload} />
        {checking.map((d) => <p key={d.id} className="mc-meta">Checking “{d.title}”…</p>)}
        {refused.map((d) => (
          <div key={d.id} className="mc-alert mc-alert-error" style={{ marginTop: 8 }}>
            “{d.title}” was not accepted: {d.scanStatus === 'INFECTED' ? 'the virus scan found a threat' : d.scanDetail}.
            <form action={removeDocument} className="mc-inline" style={{ marginLeft: 8 }}><input type="hidden" name="patientId" value={p.id} /><input type="hidden" name="documentId" value={d.id} /><Button variant="ghost">Dismiss</Button></form>
          </div>
        ))}
      </Card>

      <h2 className="mc-section-title">Timeline</h2>
      {tl.items.length ? (
        <ul className="mc-queue" aria-label="Timeline">
          {tl.items.map((i) => (
            <li key={i.id} className="mc-queue-item" data-kind={i.kind}>
              <span className="mc-token mc-token-none" style={{ minWidth: 96 }}>{day(i.occurredAt)}</span>
              <div>
                <strong>{i.title}</strong>
                <span className="mc-meta">
                  {' '}{KIND[i.kind] ?? i.kind}
                  {i.kind === 'APPOINTMENT' && i.summary.status ? ` · ${String(i.summary.status).toLowerCase().replace('_', ' ')}` : ''}
                  {i.kind === 'ENCOUNTER' && i.summary.diagnosis ? ` · ${i.summary.diagnosis}` : ''}
                  {i.kind === 'PRESCRIPTION' ? ` · ${i.summary.items} medicine${i.summary.items === 1 ? '' : 's'}` : ''}
                  {i.kind === 'DOCUMENT' ? ` · ${i.summary.by === 'staff' ? 'added by the hospital' : 'uploaded by you'}` : ''}
                </span>
              </div>
              {i.kind === 'DOCUMENT' ? <span className="mc-inline">
                  <a className="mc-btn mc-btn-ghost" href={`/care/documents/${i.refId}/download`}>Download</a>
                  {i.summary.by !== 'staff' ? <form action={removeDocument} className="mc-inline"><input type="hidden" name="patientId" value={p.id} /><input type="hidden" name="documentId" value={i.refId} /><Button variant="ghost">Remove</Button></form> : null}
                </span>
                : i.kind === 'PRESCRIPTION' ? <a className="mc-btn mc-btn-ghost" href={`/care/prescriptions/${i.refId}/pdf`}>PDF</a> : <span />}
            </li>
          ))}
        </ul>
      ) : <p className="mc-empty">Nothing yet.</p>}
      <p className="mc-meta" style={{ marginTop: 16 }}>
        {tl.next ? <><a href={`/care/timeline?${new URLSearchParams({ patientId: p.id, beforeAt: tl.next.at, beforeId: tl.next.id })}`}>Older entries</a> · </> : null}
        {sp.beforeAt ? <><a href={`/care/timeline?patientId=${p.id}`}>Newest</a> · </> : null}
        <a href={path}>Refresh</a>
      </p>
    </ZoneFrame>
  );
}
