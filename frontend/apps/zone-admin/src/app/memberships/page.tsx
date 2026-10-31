import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, Kpi, PageHeader, Select, Table } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { saveTier, toggleTier } from './actions';

export const dynamic = 'force-dynamic';

interface Benefits { bookingWindowDays: number; priorityAccess: boolean; freeVideoConsultsPerMonth: number; labDiscountPct: number; freeHomeCollection: boolean; familyMembers: number }
interface Tier { id: string; code: string; name: string; description: string | null; price: number; period: string; benefits: Benefits; active: boolean; sort: number; version: number }
interface Member { id: string; status: string; plan: { code: string; name: string; price: number; period: string }; patientName: string; startsAt: string | null; endsAt: string | null }

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : '—');
const DEFAULT: Benefits = { bookingWindowDays: 30, priorityAccess: true, freeVideoConsultsPerMonth: 1, labDiscountPct: 10, freeHomeCollection: false, familyMembers: 1 };

function TierForm({ t }: { t?: Tier }) {
  const b = t?.benefits ?? DEFAULT;
  return (
    <form action={saveTier} className="mc-form">
      {t ? <><input type="hidden" name="id" value={t.id} /><input type="hidden" name="version" value={t.version} /></> : <Field label="Code" name="code" required placeholder="GOLD" pattern="[A-Za-z][A-Za-z0-9_]{1,30}" />}
      <Field label="Name" name="name" required defaultValue={t?.name} placeholder="Gold" />
      <Field label="Price (₹)" name="price" type="number" required defaultValue={t ? String(t.price) : '499'} />
      <Select label="Billed" name="period" defaultValue={t?.period ?? 'MONTHLY'} options={[{ value: 'MONTHLY', label: 'Every month' }, { value: 'YEARLY', label: 'Every year' }]} />
      <Field label="Short description" name="description" defaultValue={t?.description ?? ''} />
      <Field label="Can book this many days ahead" name="bookingWindowDays" type="number" required defaultValue={String(b.bookingWindowDays)} />
      <Field label="Free video consults a month" name="freeVideoConsultsPerMonth" type="number" required defaultValue={String(b.freeVideoConsultsPerMonth)} />
      <Field label="Lab discount (%)" name="labDiscountPct" type="number" required defaultValue={String(b.labDiscountPct)} />
      <Field label="People covered (incl. the member)" name="familyMembers" type="number" required defaultValue={String(b.familyMembers)} />
      <Field label="Order shown" name="sort" type="number" defaultValue={String(t?.sort ?? 0)} />
      <label className="mc-radio"><input type="checkbox" name="priorityAccess" defaultChecked={b.priorityAccess} /> <span>Members-only appointment times</span></label>
      <label className="mc-radio"><input type="checkbox" name="freeHomeCollection" defaultChecked={b.freeHomeCollection} /> <span>Free home sample collection</span></label>
      <Button>{t ? `Save ${t.name}` : 'Add tier'}</Button>
    </form>
  );
}

/** Admin: the hospital's membership tiers (price, period, benefits) and who holds them. */
export default async function Memberships({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; edit?: string }> }) {
  await zoneCapabilities('admin', '/admin/memberships');
  const { accessToken: token } = (await getSession())!;
  const [tiers, members] = await Promise.all([api<Tier[]>('/api/billing/v1/membership-plans', { token }), api<Member[]>('/api/billing/v1/members', { token })]);
  const sp = await searchParams;
  const editing = tiers.find((t) => t.id === sp.edit);
  const active = members.filter((m) => m.status === 'ACTIVE');
  const monthly = active.reduce((s, m) => s + (m.plan.period === 'YEARLY' ? m.plan.price / 12 : m.plan.price), 0);

  return (
    <ZoneFrame zone="admin" path="/admin/memberships" zones={ZONES}>
      <PageHeader title="Memberships" subtitle="Paid tiers patients can join: longer booking window, members-only times, free video consults, lab discounts." />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="mc-kpis">
        <Kpi label="Active members" icon="heart" value={active.length} />
        <Kpi label="Monthly membership revenue" icon="receipt" tone="success" value={inr(Math.round(monthly))} />
        <Kpi label="Tiers on offer" icon="layers" value={tiers.filter((t) => t.active).length} sub={`${tiers.length} in all`} />
      </div>
      <Card title="Tiers">
        <Table
          rows={tiers}
          empty="No tiers yet."
          columns={[
            { header: 'Tier', cell: (t: Tier) => <><strong>{t.name}</strong> <span className="mc-meta">{t.code}</span></> },
            { header: 'Price', cell: (t) => `${inr(t.price)} / ${t.period === 'YEARLY' ? 'year' : 'month'}` },
            { header: 'Benefits', cell: (t) => <span className="mc-meta">{t.benefits.bookingWindowDays} days ahead{t.benefits.priorityAccess ? ' · priority times' : ''} · {t.benefits.freeVideoConsultsPerMonth} free video · {t.benefits.labDiscountPct}% lab{t.benefits.freeHomeCollection ? ' · free home collection' : ''} · {t.benefits.familyMembers} people</span> },
            { header: 'Members', cell: (t) => active.filter((m) => m.plan.code === t.code).length },
            { header: 'Offered', cell: (t) => <Badge tone={t.active ? 'success' : 'neutral'}>{t.active ? 'Yes' : 'Hidden'}</Badge> },
            {
              header: 'Action',
              cell: (t) => (
                <span style={{ display: 'flex', gap: 6 }}>
                  <a className="mc-btn mc-btn-ghost" href={`/admin/memberships?edit=${t.id}`}>Edit</a>
                  <form action={toggleTier}>
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="version" value={t.version} />
                    <input type="hidden" name="active" value={String(!t.active)} />
                    <Button variant="ghost">{t.active ? 'Hide' : 'Offer'}</Button>
                  </form>
                </span>
              ),
            },
          ]}
        />
      </Card>
      <Card title={editing ? `Edit ${editing.name}` : 'Add a tier'}><TierForm key={editing?.id ?? 'new'} t={editing} /></Card>
      <Card title={`Members (${members.length})`}>
        <Table
          rows={members}
          empty="Nobody has joined yet."
          columns={[
            { header: 'Patient', cell: (m: Member) => m.patientName },
            { header: 'Tier', cell: (m) => m.plan.name },
            { header: 'Status', cell: (m) => <Badge tone={m.status === 'ACTIVE' ? 'success' : m.status === 'PENDING' ? 'warning' : 'neutral'}>{m.status.toLowerCase()}</Badge> },
            { header: 'From', cell: (m) => day(m.startsAt) },
            { header: 'Until', cell: (m) => day(m.endsAt) },
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
