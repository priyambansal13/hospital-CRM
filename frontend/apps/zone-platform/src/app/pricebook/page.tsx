import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { createCoupon } from '@/lib/actions';
import { type Addon, get, inr } from '@/lib/console';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Component { plan: string | null; feature: string | null; model: string; unit: string | null; amount: number | null; included: number; tiers: { upTo: number | null; amount: number }[] | null }
interface Book { code: string; name: string; currency: string; gstPercent: number; default: boolean; components: Component[] }
interface Coupon { code: string; description: string; percentOff: number | null; amountOff: number | null; months: number | null; maxRedemptions: number | null; redeemed: number; active: boolean; createdBy: string }

const describe = (c: Component) => c.model === 'TIERED'
  ? c.tiers!.map((t, i, all) => `${i ? all[i - 1].upTo! + 1 : 1}–${t.upTo ?? '…'}: ${inr(t.amount)}`).join(' · ') + ' per doctor'
  : c.model === 'USAGE' ? `${inr(c.amount!)} per unit beyond the allowance`
  : `${inr(c.amount!)} per ${c.unit} beyond ${c.included}`;

/** Price books (seeded from backend/modules/pricebook.yaml; plan base prices are the versions' list prices) and coupons. */
export default async function PriceBook({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('platform', '/platform/pricebook');
  const p = await get<{ books: Book[]; addons: Addon[]; coupons: Coupon[] }>('/pricebook');
  return (
    <ZoneFrame zone="platform" path="/platform/pricebook" zones={ZONES}>
      <PageHeader title="Prices" subtitle="On top of each plan version's list price: seats, branches, volume tiers and usage; add-ons; coupons. GST is added on every invoice." />
      <Flash {...await searchParams} />
      {p.books.map((b) => (
        <Card key={b.code} title={`${b.name} (${b.currency})`}>
          <p style={{ marginTop: 0 }}>{b.default ? <Badge tone="success">default</Badge> : null} GST {b.gstPercent}%</p>
          <Table rows={b.components} empty="Only list prices." columns={[
            { header: 'For', cell: (c) => c.plan ?? c.feature },
            { header: 'Model', cell: (c) => c.model.toLowerCase().replace('_', ' ') },
            { header: 'Price', cell: (c) => describe(c) },
          ]} />
        </Card>
      ))}
      <Card title="Add-ons">
        <Table rows={p.addons} empty="None." columns={[
          { header: 'Add-on', cell: (a) => <><strong>{a.name}</strong><div className="mc-meta">{a.code}</div></> },
          { header: 'Gives', cell: (a) => a.module ?? `+${a.extraLimit} ${a.feature}` },
          { header: 'Price', cell: (a) => `${inr(a.listPrice)}/month` },
        ]} />
      </Card>
      <Card title="Coupons">
        <Table rows={p.coupons} empty="None." columns={[
          { header: 'Code', cell: (c) => <><strong>{c.code}</strong><div className="mc-meta">{c.description}</div></> },
          { header: 'Off', cell: (c) => (c.percentOff ? `${c.percentOff}%` : inr(c.amountOff ?? 0)) },
          { header: 'For', cell: (c) => (c.months ? `${c.months} invoice${c.months > 1 ? 's' : ''}` : 'every invoice') },
          { header: 'Used', cell: (c) => `${c.redeemed}${c.maxRedemptions ? ` of ${c.maxRedemptions}` : ''}` },
        ]} />
      </Card>
      {can(caps, 'catalog:edit:tenant') ? (
        <Card title="New coupon">
          <form action={createCoupon} className="mc-form" aria-label="New coupon">
            <Field label="Code" name="code" required placeholder="DIWALI25" pattern="[A-Za-z0-9_]{3,30}" />
            <Field label="Description" name="description" required placeholder="25% off for 2 months" />
            <Field label="Percent off" name="percentOff" type="number" hint="or an amount off below" />
            <Field label="Amount off (₹)" name="amountOff" type="number" />
            <Field label="Invoices it applies to" name="months" type="number" hint="blank = every invoice" />
            <Field label="Max uses" name="maxRedemptions" type="number" />
            <Button>Create coupon</Button>
          </form>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
