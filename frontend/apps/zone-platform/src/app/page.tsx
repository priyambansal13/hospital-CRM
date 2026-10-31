import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Bars, Card, Kpi, PageHeader, Table } from '@mc/ui';
import { get, type Hospital, type PlanSummary, STATUS, when } from '@/lib/console';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** MediCare console home: every hospital and its plan; versions waiting for a second person's approval. */
export default async function Hospitals({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('platform', '/platform');
  const [hospitals, plans] = await Promise.all([
    get<Hospital[]>('/hospitals'),
    can(caps, 'catalog:read:tenant') ? get<PlanSummary[]>('/plans') : Promise.resolve([] as PlanSummary[]),
  ]);
  const pending = plans.flatMap((p) => p.versions.filter((v) => v.status === 'PENDING').map((v) => ({ ...v, plan: p })));
  const customers = hospitals.filter((h) => !h.plan?.internal);
  const active = customers.filter((h) => h.status === 'ACTIVE');
  // list price of the plan version each hospital is on (an estimate: discounts, add-ons and usage are not in it)
  const price = (h: Hospital) => plans.find((p) => p.code === h.plan?.code)?.versions.find((v) => v.version === h.plan?.version)?.listPrice ?? 0;
  const monthly = active.reduce((n, h) => n + price(h), 0);
  const fresh = customers.filter((h) => h.since && Date.now() - Date.parse(h.since) < 30 * 86_400_000).length;
  const attention = customers.filter((h) => h.status !== 'ACTIVE' || h.overrides > 0 || !h.plan).length;
  const counts = new Map<string, number>();
  for (const h of active) counts.set(h.plan?.name ?? 'No plan', (counts.get(h.plan?.name ?? 'No plan') ?? 0) + 1);
  const byPlan = [...counts].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;
  return (
    <ZoneFrame zone="platform" path="/platform" zones={ZONES}>
      <PageHeader title="Hospitals" subtitle={`${customers.length} hospitals on MediCare`} />
      <Flash {...await searchParams} />
      <div className="mc-kpis">
        <Kpi label="Active hospitals" icon="globe" value={active.length} sub={`${customers.length - active.length} offline, suspended or deleted`} />
        <Kpi label="Monthly value (list price)" icon="chart" tone="success" value={inr(monthly)} sub="Before discounts, add-ons and usage" />
        <Kpi label="New in 30 days" icon="sparkles" value={fresh} sub="Signed up or created" />
        <Kpi label="Needs a look" icon="alert" tone={attention ? 'warning' : undefined} value={attention} sub="Not active, overrides or no plan" />
      </div>
      {byPlan.length ? <Card title="Hospitals by plan"><Bars rows={byPlan} /></Card> : null}
      {pending.length ? (
        <Card title="Waiting for approval">
          <Table rows={pending} empty="" columns={[
            { header: 'Plan', cell: (v) => <a href={`/platform/plans/versions/${v.id}`}><strong>{v.plan.name}</strong> v{v.version}</a> },
            { header: 'Submitted by', cell: (v) => v.submittedBy ?? '—' },
            { header: 'Price', cell: (v) => `₹${v.listPrice}/month` },
          ]} />
        </Card>
      ) : null}
      <Card title="All hospitals">
        <Table rows={customers} empty="No hospitals yet." columns={[
          { header: 'Hospital', cell: (h) => <><a href={`/platform/hospitals/${h.id}`}><strong>{h.slug}</strong></a>{h.status !== 'ACTIVE' ? <> <Badge tone="warning">{h.status.toLowerCase()}</Badge></> : null}</> },
          { header: 'Plan', cell: (h) => (h.plan ? <>{h.plan.name} <span className="mc-meta">v{h.plan.version}</span>{h.plan.versionStatus === 'RETIRED' ? <> <Badge tone={STATUS.RETIRED.tone}>retired version</Badge></> : null}</> : <Badge tone="warning">no plan</Badge>) },
          { header: 'Add-ons', cell: (h) => (h.addons.length ? h.addons.join(', ') : '—') },
          { header: 'Overrides', cell: (h) => (h.overrides ? <Badge tone="warning">{h.overrides}</Badge> : '—') },
          { header: 'Since', cell: (h) => <span className="mc-meta">{when(h.since)}</span> },
        ]} />
      </Card>
    </ZoneFrame>
  );
}
