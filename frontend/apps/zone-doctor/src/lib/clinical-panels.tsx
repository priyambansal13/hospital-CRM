import { api, ApiError } from '@mc/bff';
import { Alert, Badge, Button, Card, Field, Select, Table } from '@mc/ui';
import { addAllergyForPatient } from './consult-actions';

interface Allergy { id: string; substance: string; severity: string; reaction: string | null; recordedBy: { kind: string; name: string | null } }
interface Doc { id: string; title: string; type: string; issuedOn: string | null; createdAt: string; uploadedBy: { kind: string; name: string | null } }

export async function loadAllergies(token: string, patientId: string): Promise<Allergy[] | null> {
  return api<Allergy[]>(`/api/patient/v1/patients/${patientId}/allergies`, { token }).catch((e) => (e instanceof ApiError && e.status === 403 ? null : Promise.reject(e)));
}

/** Allergies, prominent where prescribing happens. Treating doctors can add one. */
export function AllergyPanel({ allergies, patientId, back, canAdd }: { allergies: Allergy[] | null; patientId: string; back: string; canAdd: boolean }) {
  if (!allergies) return null;
  const severe = allergies.filter((a) => a.severity === 'SEVERE');
  return (
    <Card title={`Allergies${allergies.length ? ` (${allergies.length})` : ''}`}>
      {severe.length ? <Alert tone="error">Severe allergy: {severe.map((a) => a.substance).join(', ')}</Alert> : null}
      {allergies.length ? (
        <ul className="mc-queue" aria-label="Allergies">
          {allergies.map((a) => (
            <li key={a.id} className="mc-queue-item">
              <Badge tone={a.severity === 'SEVERE' ? 'danger' : a.severity === 'MODERATE' ? 'warning' : 'neutral'}>{a.severity.toLowerCase()}</Badge>
              <div><strong>{a.substance}</strong><span className="mc-meta">{a.reaction ? ` · ${a.reaction}` : ''} · {a.recordedBy.kind === 'patient' ? 'reported by patient' : a.recordedBy.name}</span></div>
              <span />
            </li>
          ))}
        </ul>
      ) : <p className="mc-empty">No known allergies recorded.</p>}
      {canAdd ? (
        <form action={addAllergyForPatient} className="mc-form" style={{ marginTop: 12 }}>
          <input type="hidden" name="patientId" value={patientId} /><input type="hidden" name="back" value={back} />
          <Field label="Allergy" name="substance" required />
          <Select label="Severity" name="severity" options={[{ value: 'UNKNOWN', label: 'Unknown' }, { value: 'MILD', label: 'Mild' }, { value: 'MODERATE', label: 'Moderate' }, { value: 'SEVERE', label: 'Severe' }]} />
          <Field label="Reaction" name="reaction" />
          <Button variant="ghost">Record allergy</Button>
        </form>
      ) : null}
    </Card>
  );
}

export async function DocumentsPanel({ token, patientId }: { token: string; patientId: string }) {
  const docs = await api<Doc[]>(`/api/records/v1/patients/${patientId}/documents`, { token }).catch((e) => (e instanceof ApiError && e.status === 403 ? null : Promise.reject(e)));
  if (!docs) return null;
  const day = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
  return (
    <Card title="Documents">
      <Table rows={docs} empty="No documents." columns={[
        { header: 'Date', cell: (d) => day(d.issuedOn ?? d.createdAt) },
        { header: 'Title', cell: (d) => d.title },
        { header: 'Type', cell: (d) => d.type.toLowerCase().replace('_', ' ') },
        { header: 'From', cell: (d) => (d.uploadedBy.kind === 'patient' ? 'patient' : d.uploadedBy.name ?? 'hospital') },
        { header: '', cell: (d) => <a href={`/doctor/documents/${d.id}/download`}>Download</a> },
      ]} />
    </Card>
  );
}
