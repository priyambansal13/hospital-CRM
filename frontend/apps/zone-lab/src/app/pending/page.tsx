import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { ReadOnlyNotice } from '@mc/features/plan';
import { Badge, Button, Card, Chip, PageHeader, Table } from '@mc/ui';
import { acknowledgeAlert } from '@/lib/result-actions';
import { Flash } from '@/lib/flash';
import { age, type LabOrder, STATUS } from '@/lib/lab';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Alert { id: string; orderId: string; orderNo: string; patient: { name: string; mrn: string }; test: string; parameter: string; value: string; unit: string | null; flag: string; createdAt: string; acknowledgedAt: string | null }
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : '—');

/** Samples in the lab waiting for results or verification, overdue first; critical values from self-booked tests. */
export default async function Pending({ searchParams }: { searchParams: Promise<{ branch?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('lab', '/lab/pending');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const branches = await api<{ id: string; name: string }[]>('/api/diagnostics/v1/public/lab-branches', { token });
  const branch = branches.find((b) => b.id === sp.branch) ?? branches.find((b) => b.name === 'Sector 44') ?? branches[0];
  const orders = branch ? await api<LabOrder[]>(`/api/diagnostics/v1/lab/pending?branchId=${branch.id}`, { token }) : [];
  const alerts = can(caps, 'report:verify:branch') ? await api<Alert[]>('/api/diagnostics/v1/lab/critical-alerts', { token }) : [];
  const open = alerts.filter((a) => !a.acknowledgedAt);
  return (
    <ZoneFrame zone="lab" path="/lab/pending" zones={ZONES}>
      <PageHeader title="Pending results" subtitle={branch ? branch.name : undefined} />
      <ReadOnlyNotice caps={caps} module="diagnostics" />
      <Flash ok={sp.ok} error={sp.error} />
      {branches.length > 1 ? <div className="mc-chips">{branches.map((b) => <Chip key={b.id} href={`/lab/pending?branch=${b.id}`} active={b.id === branch?.id}>{b.name}</Chip>)}</div> : null}
      {open.length ? (
        <Card title={`Critical values to act on (${open.length})`}>
          <Table rows={open} empty="" columns={[
            { header: 'Patient', cell: (a) => <>{a.patient.name} <span className="mc-meta">{a.patient.mrn}</span></> },
            { header: 'Value', cell: (a) => <strong style={{ color: 'var(--danger)' }}>{a.test}: {a.parameter} {a.value} {a.unit ?? ''}</strong> },
            { header: 'Since', cell: (a) => when(a.createdAt) },
            { header: '', cell: (a) => <form action={acknowledgeAlert} className="mc-inline"><input type="hidden" name="alertId" value={a.id} /><input type="hidden" name="back" value="/lab/pending" /><Button variant="danger">Acknowledge</Button></form> },
          ]} />
        </Card>
      ) : null}
      <Card title={`Waiting (${orders.length})`}>
        <Table rows={orders} empty="Nothing waiting." columns={[
          { header: 'Order', cell: (o) => <a href={`/lab/orders/${o.id}`}>{o.orderNo}</a> },
          { header: 'Patient', cell: (o) => <>{o.patient.name} <span className="mc-meta">{o.patient.mrn} · {age(o.patient.dob) ?? '?'} y</span></> },
          { header: 'Tests', cell: (o) => <span className="mc-meta">{o.tests.map((t) => t.code).join(', ')}</span> },
          { header: 'Due', cell: (o) => <>{when(o.dueAt ?? null)} {o.overdue ? <Badge tone="danger">overdue</Badge> : null}</> },
          { header: 'Status', cell: (o) => <Badge tone={STATUS[o.status]?.tone ?? 'neutral'}>{STATUS[o.status]?.label ?? o.status.toLowerCase().replace('_', ' ')}</Badge> },
        ]} />
      </Card>
    </ZoneFrame>
  );
}
