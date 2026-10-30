import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, PageHeader, Table } from '@mc/ui';
import { notFound } from 'next/navigation';
import { Flash } from '@/lib/flash';
import { acknowledgeAlert, communicatedAlert } from '@/lib/result-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface CriticalAlert {
  id: string; orderNo: string; patient: { name: string; mrn: string }; test: string; parameter: string; value: string; unit: string | null;
  createdAt: string; acknowledgedAt: string | null; acknowledgedBy: string | null; forDoctor: boolean; orderedBy: string | null; level: number;
  communicated: { to: string; at: string; by: string | null; readBack: boolean } | null;
}
const when = (d: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(d));
const mins = (d: string) => Math.max(0, Math.round((Date.now() - Date.parse(d)) / 60_000));
const LEVEL = ['with the doctor', 'escalated to pathologists', 'escalated to on-call'];

/**
 * Critical values at the lab's branches until someone has acted (review C-2): doctors' ones still unacknowledged (phone
 * them through and record the read-back) and self-booked ones (the lab acknowledges after telling the patient's doctor).
 */
export default async function CriticalValues({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('lab', '/lab/critical');
  if (!can(caps, 'report:verify:branch')) notFound();
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const alerts = await api<CriticalAlert[]>('/api/diagnostics/v1/lab/critical-alerts', { token });
  const outstanding = alerts.filter((a) => !a.acknowledgedAt && !a.communicated);
  const handled = alerts.filter((a) => a.acknowledgedAt || a.communicated);
  return (
    <ZoneFrame zone="lab" path="/lab/critical" zones={ZONES}>
      <PageHeader title="Critical values" subtitle="Until a doctor has them: phone the value through, have it read back, and record it here." />
      <Flash {...sp} />
      <Card title={`Outstanding (${outstanding.length})`}>
        <Table rows={outstanding} empty="Nothing outstanding." columns={[
          { header: 'Patient', cell: (a) => <>{a.patient.name} <span className="mc-meta">{a.patient.mrn} · {a.orderNo}</span></> },
          { header: 'Value', cell: (a) => <strong style={{ color: 'var(--danger)' }}>{a.test}: {a.parameter} {a.value} {a.unit ?? ''}</strong> },
          { header: 'Doctor', cell: (a) => (a.forDoctor ? a.orderedBy ?? 'Ordering doctor' : <span className="mc-meta">self-booked</span>) },
          { header: 'Open for', cell: (a) => <>{mins(a.createdAt)} min <Badge tone={a.level ? 'danger' : 'warning'}>{LEVEL[a.level] ?? 'escalated'}</Badge></> },
          { header: '', cell: (a) => (
            <form action={communicatedAlert} className="mc-inline" aria-label={`Phoned through for ${a.patient.name}`}>
              <input type="hidden" name="alertId" value={a.id} />
              <input type="hidden" name="back" value="/lab/critical" />
              <input name="communicatedTo" required placeholder="Told whom (e.g. Dr. Rao)" aria-label="Told whom" className="mc-input-sm" />
              <label className="mc-meta"><input type="checkbox" name="readBack" required /> read back</label>
              <Button variant="danger">Phoned through</Button>
            </form>
          ) },
          { header: '', cell: (a) => (!a.forDoctor ? (
            <form action={acknowledgeAlert} className="mc-inline"><input type="hidden" name="alertId" value={a.id} /><input type="hidden" name="back" value="/lab/critical" /><Button variant="ghost">Acknowledge</Button></form>
          ) : null) },
        ]} />
      </Card>
      <Card title="Handled (last 7 days)">
        <Table rows={handled} empty="None." columns={[
          { header: 'Patient', cell: (a) => <>{a.patient.name} <span className="mc-meta">{a.orderNo}</span></> },
          { header: 'Value', cell: (a) => `${a.test}: ${a.parameter} ${a.value} ${a.unit ?? ''}` },
          { header: 'How', cell: (a) => (a.communicated
            ? `Phoned to ${a.communicated.to} by ${a.communicated.by ?? 'the lab'}${a.communicated.readBack ? ', read back' : ''} (${when(a.communicated.at)})`
            : `Acknowledged by ${a.acknowledgedBy ?? 'the doctor'} (${when(a.acknowledgedAt!)})`) },
        ]} />
      </Card>
    </ZoneFrame>
  );
}
