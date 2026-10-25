import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Card, PageHeader } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface ModuleRow { key: string; name: string; state: string; active: boolean; alwaysOn: boolean }
const STATE: Record<string, [string, 'success' | 'warning' | 'neutral']> = { ACTIVE: ['Active', 'success'], ACTIVATING: ['Switching on', 'warning'], DISABLING: ['Switching off', 'warning'], READ_ONLY: ['Read only', 'neutral'] };

export default async function Overview() {
  const caps = await zoneCapabilities('admin', '/admin');
  const { accessToken: token } = (await getSession())!;
  const [modules, branches, staff] = await Promise.all([
    api<ModuleRow[]>('/api/entitlement/v1/modules', { token }),
    can(caps, 'branch:read:tenant') ? api<unknown[]>('/api/tenant/v1/branches', { token }) : Promise.resolve(null),
    can(caps, 'staff:read:tenant') ? api<unknown[]>('/api/iam/v1/staff', { token }) : Promise.resolve(null),
  ]);
  const setup = can(caps, 'settings:manage:tenant') ? await api<{ completedAt: string | null; source: string }>('/api/tenant/v1/setup', { token }).then((x) => (x.source === 'SIGNUP' ? x : null)).catch(() => null) : null;
  return (
    <ZoneFrame zone="admin" path="/admin" zones={ZONES}>
      <PageHeader title="Hospital overview" subtitle="Your hospital at a glance." />
      <div className="mc-grid">
        {branches ? <Card title="Branches"><p className="mc-stat">{branches.length}</p><a href="/admin/branches">Manage branches</a></Card> : null}
        {staff ? <Card title="Staff"><p className="mc-stat">{staff.length}</p><a href="/admin/staff">Manage staff</a></Card> : null}
      </div>
      {setup && !setup.completedAt ? (
        <Card title="Finish setting up">
          <p style={{ marginTop: 0 }}>A few steps get your hospital ready for patients: branding, a branch, a doctor, opening hours and payments.</p>
          <a className="mc-btn mc-btn-primary" href="/admin/setup">Continue setup</a>
        </Card>
      ) : null}
      <Card title="Modules in your plan">
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {modules.map((m) => (
            <li key={m.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span>{m.name}</span>
              <Badge tone={STATE[m.state]?.[1] ?? 'neutral'}>{STATE[m.state]?.[0] ?? 'Not in plan'}</Badge>
            </li>
          ))}
        </ul>
        {can(caps, 'plan:read:tenant') ? <p style={{ marginBottom: 0 }}><a href="/admin/plan">Your plan and limits</a></p> : null}
      </Card>
    </ZoneFrame>
  );
}
