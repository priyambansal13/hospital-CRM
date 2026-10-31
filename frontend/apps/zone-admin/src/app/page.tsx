import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Bars, Card, Columns, Icon, Kpi, PageHeader } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface ModuleRow { key: string; name: string; state: string; active: boolean; alwaysOn: boolean }
interface Stats { today: { booked: number; waiting: number; inProgress: number; completed: number; noShow: number; cancelled: number }; next7: { date: string; count: number }[]; sources: Record<string, number>; busiestDoctors: { name: string; count: number }[] }
interface Day { totals: { collectedOnline: number; collectedAtCounter: number; refunded: number; outstanding: number } }
const STATE: Record<string, [string, 'success' | 'warning' | 'neutral']> = { ACTIVE: ['Active', 'success'], ACTIVATING: ['Switching on', 'warning'], DISABLING: ['Switching off', 'warning'], READ_ONLY: ['Read only', 'neutral'] };
const SOURCE: Record<string, string> = { ONLINE: 'Online (app and website)', DESK: 'Front desk', WALK_IN: 'Walk-in', ASSISTANT: 'AI assistant' };
const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n)}`;
const soft = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
const weekday = (d: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

/** The admin's home: today's numbers, the week ahead, how patients book, and the plan. Each block needs its permission. */
export default async function Overview() {
  const caps = await zoneCapabilities('admin', '/admin');
  const { accessToken: token } = (await getSession())!;
  const [modules, branches, staff, doctors, stats, billing, handoffs] = await Promise.all([
    api<ModuleRow[]>('/api/entitlement/v1/modules', { token }),
    can(caps, 'branch:read:tenant') ? soft(api<{ active?: boolean }[]>('/api/tenant/v1/branches', { token })) : null,
    can(caps, 'staff:read:tenant') ? soft(api<unknown[]>('/api/iam/v1/staff', { token })) : null,
    can(caps, 'doctor:manage:tenant') ? soft(api<{ items: { status: string }[] }>('/api/provider/v1/doctors?limit=100', { token })) : null,
    can(caps, 'schedule:manage:branch') ? soft(api<Stats>('/api/scheduling/v1/stats/overview', { token })) : null,
    can(caps, 'invoice:read:branch') || can(caps, 'billing:read:tenant') ? soft(api<Day>('/api/billing/v1/invoices', { token })) : null,
    can(caps, 'assistant_handoff:manage:branch') ? soft(api<{ open: number; emergency: number }>('/api/assistant/v1/assistant/handoffs/summary', { token })) : null,
  ]);
  const setup = can(caps, 'settings:manage:tenant') ? await api<{ completedAt: string | null; source: string }>('/api/tenant/v1/setup', { token }).then((x) => (x.source === 'SIGNUP' ? x : null)).catch(() => null) : null;
  const activeDoctors = doctors?.items.filter((d) => d.status === 'ACTIVE').length;
  const drafts = doctors ? doctors.items.length - (activeDoctors ?? 0) : 0;
  const collected = billing ? billing.totals.collectedOnline + billing.totals.collectedAtCounter : null;
  const hello = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date());
  const greeting = Number(hello) < 12 ? 'Good morning' : Number(hello) < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <ZoneFrame zone="admin" path="/admin" zones={ZONES}>
      <PageHeader
        title="Hospital overview"
        subtitle={`${greeting}. Here is your hospital today, ${new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }).format(new Date())}.`}
        actions={<>
          {can(caps, 'doctor:manage:tenant') ? <a className="mc-btn mc-btn-ghost" href="/admin/doctors">Add a doctor</a> : null}
          {can(caps, 'staff:manage:tenant') ? <a className="mc-btn mc-btn-primary" href="/admin/staff">Invite staff</a> : null}
        </>}
      />
      {setup && !setup.completedAt ? (
        <Card title="Finish setting up">
          <p style={{ marginTop: 0 }}>A few steps get your hospital ready for patients: branding, a branch, a doctor, opening hours and payments.</p>
          <a className="mc-btn mc-btn-primary" href="/admin/setup">Continue setup</a>
        </Card>
      ) : null}

      <div className="mc-kpis">
        {stats ? <Kpi label="Appointments today" icon="calendar" value={stats.today.booked} sub={`${stats.today.waiting} waiting · ${stats.today.inProgress} with a doctor · ${stats.today.completed} done`} href="/desk" /> : null}
        {collected !== null ? <Kpi label="Collected today" icon="receipt" tone="success" value={inr(collected)} sub={billing!.totals.outstanding ? `${inr(billing!.totals.outstanding)} still to collect` : 'Nothing outstanding'} href="/admin/billing" /> : null}
        {doctors ? <Kpi label="Doctors" icon="stethoscope" value={activeDoctors} sub={drafts ? `${drafts} not published yet` : 'All published'} href="/admin/doctors" /> : null}
        {handoffs ? <Kpi label="Chat requests" icon="chat" tone={handoffs.emergency ? 'danger' : handoffs.open ? 'warning' : undefined} value={handoffs.open} sub={handoffs.emergency ? `${handoffs.emergency} marked emergency` : 'Patients waiting for a call back'} href="/desk/assistant" /> : null}
        {staff ? <Kpi label="Staff" icon="users" value={staff.length} href="/admin/staff" /> : null}
        {branches ? <Kpi label="Branches" icon="building" value={branches.filter((b) => b.active !== false).length} href="/admin/branches" /> : null}
      </div>

      {stats ? (
        <div className="mc-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          <Card title="The week ahead">
            <Columns rows={stats.next7.map((d, i) => ({ label: i === 0 ? 'Today' : weekday(d.date), value: d.count }))} />
            <p className="mc-meta" style={{ marginBottom: 0 }}>{stats.next7.reduce((n, d) => n + d.count, 0)} appointments booked for the next 7 days</p>
          </Card>
          <Card title="How patients booked (30 days)">
            <Bars rows={Object.entries(stats.sources).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: SOURCE[k] ?? k, value: v }))} />
          </Card>
          <Card title="Busiest doctors this week">
            <Bars rows={stats.busiestDoctors.map((d) => ({ label: d.name, value: d.count }))} />
          </Card>
        </div>
      ) : null}

      <Card title="Modules in your plan">
        <ul className="mc-tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', listStyle: 'none', padding: 0, margin: 0 }}>
          {modules.map((m) => (
            <li key={m.key} className="mc-branch" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Icon name={m.state === 'ACTIVE' ? 'shield' : 'layers'} size={18} />{m.name}</span>
              <Badge tone={STATE[m.state]?.[1] ?? 'neutral'}>{STATE[m.state]?.[0] ?? 'Not in plan'}</Badge>
            </li>
          ))}
        </ul>
        {can(caps, 'plan:read:tenant') ? <p style={{ marginBottom: 0 }}><a href="/admin/plan">Your plan and limits</a></p> : null}
      </Card>
    </ZoneFrame>
  );
}
