import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Card, PageHeader } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Rx {
  id: string; prescriptionNo: string; issuedAt: string; followUpOn: string | null; advice: string | null; doctor: { name: string }; patient: { name: string };
  diagnoses: { code: string | null; description: string }[];
  items: { drugName: string; strength: string | null; form: string | null; dosage: string; durationDays: number | null; instructions: string | null }[];
}
const day = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Prescriptions for the account (self and family), newest first, with the PDF. */
export default async function Prescriptions() {
  const caps = await zoneCapabilities('patient', '/care/prescriptions');
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path="/care/prescriptions" zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  const list = await api<Rx[]>('/api/records/v1/me/prescriptions', { token });
  return (
    <ZoneFrame zone="patient" path="/care/prescriptions" zones={ZONES}>
      <PageHeader title="Prescriptions" subtitle="From your visits, for you and your family." />
      {!list.length ? <Card><p className="mc-empty">No prescriptions yet.</p></Card> : null}
      {list.map((rx) => (
        <article key={rx.id} className="mc-card" aria-label={`Prescription ${rx.prescriptionNo}`}>
          <h3 style={{ marginTop: 0 }}>{day(rx.issuedAt)} · {rx.doctor.name}</h3>
          <p className="mc-meta" style={{ marginTop: 0 }}>For {rx.patient.name} · {rx.prescriptionNo}{rx.diagnoses.length ? ` · ${rx.diagnoses.map((d) => d.description).join(', ')}` : ''}</p>
          <ul>
            {rx.items.map((i, n) => (
              <li key={n}><strong>{i.drugName}{i.strength ? ` ${i.strength}` : ''}</strong>{i.form ? ` (${i.form})` : ''}: {i.dosage}{i.durationDays ? ` for ${i.durationDays} days` : ''}{i.instructions ? `, ${i.instructions}` : ''}</li>
            ))}
          </ul>
          {rx.advice ? <p><strong>Advice:</strong> {rx.advice}</p> : null}
          {rx.followUpOn ? <p><strong>Follow up:</strong> {day(rx.followUpOn)}</p> : null}
          <a className="mc-btn mc-btn-ghost" href={`/care/prescriptions/${rx.id}/pdf`}>Download PDF</a>
        </article>
      ))}
    </ZoneFrame>
  );
}
