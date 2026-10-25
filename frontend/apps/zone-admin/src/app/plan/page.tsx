import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Upsell } from '@mc/features/plan';
import { Badge, Card, PageHeader, Table } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Plan {
  plan: { code: string; name: string; tier: string; edition: string; version: number; listPrice: number };
  addons: { code: string; name: string; quantity: number }[];
  since: string;
  modules: { key: string; name: string; source: 'PLAN' | 'ADDON' | 'OVERRIDE' | 'TRIAL' }[];
  features: { key: string; name: string; type: 'BOOLEAN' | 'LIMIT' | 'METERED'; unit: string | null; module: string; enabled: boolean; limit: number | null }[];
}
interface ModuleRow { key: string; name: string; state: string; alwaysOn: boolean }
interface CatalogPlan { code: string; name: string; tier: string; edition: string; listPrice: number; modules: { key: string; name: string }[] }

const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;
const STATE: Record<string, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  ACTIVATING: { label: 'Switching on', tone: 'warning' },
  DISABLING: { label: 'Switching off', tone: 'warning' },
  READ_ONLY: { label: 'Read only', tone: 'neutral' },
};
const SOURCE: Record<string, string> = { PLAN: 'in plan', ADDON: 'add-on', OVERRIDE: 'added by MediCare', TRIAL: 'trial' };

/** The hospital's plan: modules (and their state), limits with current use, and what upgrading would unlock. */
export default async function PlanPage() {
  const caps = await zoneCapabilities('admin', '/admin/plan');
  const { accessToken: token } = (await getSession())!;
  const [plan, modules, catalogue, branches, doctors] = await Promise.all([
    api<Plan>('/api/subscription/v1/plan', { token }),
    api<ModuleRow[]>('/api/entitlement/v1/modules', { token }),
    api<CatalogPlan[]>('/api/subscription/v1/plans', { token }),
    can(caps, 'branch:read:tenant') ? api<{ active: boolean }[]>('/api/tenant/v1/branches', { token }) : Promise.resolve(null),
    can(caps, 'doctor:manage:tenant') ? api<{ items: { status: string }[]; nextCursor?: string | null }>('/api/provider/v1/doctors?limit=100', { token }).catch(() => null) : Promise.resolve(null),
  ]);
  const used: Record<string, number | undefined> = {
    'core.branches': branches?.filter((b) => b.active).length,
    // one page of 100 is enough to show use against the smaller plans' limits
    'directory.doctors': doctors && !doctors.nextCursor ? doctors.items.filter((d) => d.status !== 'INACTIVE').length : undefined,
  };
  const source = new Map(plan.modules.map((m) => [m.key, m.source]));
  const limits = plan.features.filter((f) => f.type === 'LIMIT');
  const switches = plan.features.filter((f) => f.type === 'BOOLEAN');
  return (
    <ZoneFrame zone="admin" path="/admin/plan" zones={ZONES}>
      <PageHeader title="Plan" subtitle="What your hospital has from MediCare: modules, limits and what an upgrade would add." />
      <Card title={`${plan.plan.name} · ${plan.plan.edition}`}>
        <dl className="mc-dl">
          <dt>Plan</dt><dd><strong>{plan.plan.name}</strong> (version {plan.plan.version}) · {inr(plan.plan.listPrice)}/month</dd>
          <dt>Add-ons</dt><dd>{plan.addons.length ? plan.addons.map((a) => `${a.name}${a.quantity > 1 ? ` × ${a.quantity}` : ''}`).join(', ') : 'None'}</dd>
          <dt>Since</dt><dd>{new Date(plan.since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</dd>
        </dl>
        {can(caps, 'subscription:manage:tenant') ? <p style={{ marginBottom: 0 }}><a href="/account">Subscription, invoices and usage</a> · <a href="/account/plan">Change plan</a></p> : null}
      </Card>
      <Card title="Modules">
        <Table rows={modules} empty="No modules." columns={[
          { header: 'Module', cell: (m) => <strong>{m.name}</strong> },
          { header: 'State', cell: (m) => {
            const s = STATE[m.state];
            return s ? <><Badge tone={s.tone}>{s.label}</Badge>{source.has(m.key) && !m.alwaysOn ? <span className="mc-meta"> {SOURCE[source.get(m.key)!]}</span> : null}</> : <Badge>Not in plan</Badge>;
          } },
          { header: '', cell: (m) => (m.state === 'READ_ONLY'
            ? <><p className="mc-meta" style={{ marginTop: 0 }}>Records stay viewable; nothing new can be added.</p><Upsell module={m.key} compact /></>
            : !STATE[m.state] ? <Upsell module={m.key} compact /> : null) },
        ]} />
      </Card>
      <Card title="Limits">
        <Table rows={limits} empty="No limits." columns={[
          { header: 'What', cell: (f) => f.name },
          { header: 'Allowed', cell: (f) => (f.limit == null ? 'Unlimited' : `${f.limit} ${f.limit === 1 ? (f.unit ?? '').replace(/s$/, '') : (f.unit ?? '')}`) },
          { header: 'In use', cell: (f) => (used[f.key] == null ? '—' : <>{used[f.key]}{f.limit != null && used[f.key]! >= f.limit ? <> <Badge tone="warning">limit reached</Badge></> : null}</>) },
          { header: '', cell: (f) => (f.limit != null && used[f.key] != null && used[f.key]! >= f.limit ? <Upsell feature={f.key} compact /> : null) },
        ]} />
      </Card>
      <Card title="Features">
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
          {switches.map((f) => <li key={f.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>{f.name}</span><Badge tone={f.enabled ? 'success' : 'neutral'}>{f.enabled ? 'Included' : 'Not in plan'}</Badge></li>)}
        </ul>
      </Card>
      <Card title="MediCare plans">
        <Table rows={catalogue} empty="No plans." columns={[
          { header: 'Plan', cell: (p) => <><strong>{p.name}</strong>{p.code === plan.plan.code ? <> <Badge tone="success">your plan</Badge></> : null}<div className="mc-meta">{p.edition}</div></> },
          { header: 'Modules', cell: (p) => p.modules.filter((m) => m.key !== 'core').map((m) => m.name).join(', ') },
          { header: 'Price', cell: (p) => `${inr(p.listPrice)}/month` },
        ]} />
      </Card>
    </ZoneFrame>
  );
}
