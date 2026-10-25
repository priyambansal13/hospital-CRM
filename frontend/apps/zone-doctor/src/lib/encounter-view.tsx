import { Badge, Card } from '@mc/ui';
import { day, type Encounter, vitalsLine } from './records';

/** A past visit, read-only (chart and consultation history). */
export function EncounterCard({ e }: { e: Encounter }) {
  return (
    <Card title={`${day(e.startedAt)} · ${e.doctor.name}`}>
      <p className="mc-meta" style={{ margin: 0 }}>
        <Badge tone={e.status === 'OPEN' ? 'warning' : 'success'}>{e.status.toLowerCase()}</Badge> {vitalsLine(e.vitals)}
      </p>
      {e.chiefComplaint ? <p><strong>Complaint:</strong> {e.chiefComplaint}</p> : null}
      {e.diagnoses.length ? <p><strong>Diagnosis:</strong> {e.diagnoses.map((d) => `${d.description}${d.code ? ` (${d.code})` : ''}`).join('; ')}</p> : null}
      {e.notes ? <p style={{ whiteSpace: 'pre-wrap' }}>{e.notes}</p> : null}
      {e.prescriptions.map((p) => (
        <p key={p.id} className="mc-meta">
          {p.prescriptionNo}: {p.items.map((i) => `${i.drugName}${i.strength ? ` ${i.strength}` : ''} ${i.dosage}`).join(', ')} · <a href={`/doctor/prescriptions/${p.id}/pdf`}>PDF</a>
        </p>
      ))}
      {e.amendments.map((a, i) => <p key={i} className="mc-meta">Amended {day(a.at)} by {a.by ?? 'doctor'}: {a.reason} ({a.changed.join(', ')})</p>)}
    </Card>
  );
}
