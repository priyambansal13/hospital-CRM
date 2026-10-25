import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame } from '@mc/features';
import { Badge, Button, Card, PageHeader, Table } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { type CriticalAlert, type OrderedTest, STATUS, when } from '@/lib/lab';
import { acknowledgeCritical } from '@/lib/lab-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** Critical values first (shown before the report is verified), then the tests this doctor ordered. */
export default async function LabResults({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { accessToken: token } = (await getSession())!;
  const [alerts, orders] = await Promise.all([
    api<CriticalAlert[]>('/api/diagnostics/v1/doctor/critical-alerts', { token }),
    api<OrderedTest[]>('/api/diagnostics/v1/doctor/lab-orders', { token }),
  ]);
  const open = alerts.filter((a) => !a.acknowledgedAt);
  return (
    <ZoneFrame zone="doctor" path="/doctor/lab-results" zones={ZONES}>
      <PageHeader title="Lab results" />
      <Flash {...await searchParams} />
      {open.length ? (
        <Card title={`Critical values (${open.length})`}>
          <Table rows={open} empty="" columns={[
            { header: 'Patient', cell: (a) => <a href={`/doctor/lab-results/${a.orderId}`}>{a.patient.name} <span className="mc-meta">{a.patient.mrn}</span></a> },
            { header: 'Value', cell: (a) => <strong style={{ color: 'var(--danger)' }}>{a.test} · {a.parameter}: {a.value} {a.unit ?? ''}</strong> },
            { header: 'Reported', cell: (a) => when(a.createdAt) },
            { header: '', cell: (a) => <form action={acknowledgeCritical} className="mc-inline"><input type="hidden" name="alertId" value={a.id} /><Button variant="danger">Acknowledge</Button></form> },
          ]} />
        </Card>
      ) : null}
      <Card title="Tests you ordered (last 90 days)">
        <Table rows={orders} empty="No tests ordered yet." columns={[
          { header: 'Patient', cell: (o) => <>{o.patient.name} <span className="mc-meta">{o.patient.mrn}</span></> },
          { header: 'Tests', cell: (o) => <span className="mc-meta">{o.tests}</span> },
          { header: 'Ordered', cell: (o) => when(o.createdAt) },
          { header: 'Status', cell: (o) => o.report
            ? <>{o.report.critical_count ? <Badge tone="danger">{o.report.critical_count} critical</Badge> : null} {o.report.abnormal_count ? <Badge tone="warning">{o.report.abnormal_count} abnormal</Badge> : <Badge tone="success">all normal</Badge>}</>
            : <span className="mc-meta">{STATUS[o.status] ?? o.status}</span> },
          { header: '', cell: (o) => (o.report || ['RESULTS_ENTERED', 'IN_LAB'].includes(o.status) ? <a href={`/doctor/lab-results/${o.id}`}>{o.report ? 'View report' : 'View'}</a> : null) },
        ]} />
      </Card>
    </ZoneFrame>
  );
}
