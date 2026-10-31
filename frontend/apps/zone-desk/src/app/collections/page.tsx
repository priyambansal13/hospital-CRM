import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, iconFor, Kpi, PageHeader, Table } from '@mc/ui';
import { notFound } from 'next/navigation';
import { handedBack } from '@/lib/desk-actions';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Invoice { id: string; invoiceNo: string; status: string; patient: { name: string; mrn: string }; description: string; total: number; amountPaid: number; amountRefunded: number; paidAt: string | null }
interface Day { date: string; totals: { collectedOnline: number; collectedAtCounter: number; refunded: number; outstanding: number }; items: Invoice[] }
interface HandBack { id: string; amount: number; reason: string; requestedAt: string; paidBy: string | null; invoice: { id: string; invoiceNo: string }; patient: { name: string; mrn: string } }

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const when = (d: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(d));

/** The counter's day: what came in, receipts to print, and refunds to hand back (E-3, cash refund hand-back). */
export default async function Collections({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('desk', '/desk/collections');
  if (!can(caps, 'payment:collect:branch')) notFound();
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const [day, refunds] = await Promise.all([
    can(caps, 'invoice:read:branch') ? api<Day>('/api/billing/v1/invoices', { token }).catch(() => null) : Promise.resolve(null),
    api<HandBack[]>('/api/billing/v1/desk/refunds', { token }).catch(() => [] as HandBack[]),
  ]);
  return (
    <ZoneFrame zone="desk" path="/desk/collections" zones={ZONES}>
      <PageHeader title="Collections" subtitle="Today's money at your branch, receipts, and refunds to give back." />
      <Flash {...sp} />
      <Card title={`Refunds to hand back (${refunds.length})`}>
        <Table rows={refunds} empty="Nothing to hand back." columns={[
          { header: 'Patient', cell: (r) => <>{r.patient.name} <span className="mc-meta">{r.patient.mrn}</span></> },
          { header: 'Amount', cell: (r) => <strong>{inr(r.amount)}</strong> },
          { header: 'Why', cell: (r) => <span className="mc-meta">{r.reason} · {r.invoice.invoiceNo} · {when(r.requestedAt)}</span> },
          { header: '', cell: (r) => (
            <form action={handedBack} className="mc-inline" aria-label={`Hand back to ${r.patient.name}`}>
              <input type="hidden" name="id" value={r.id} />
              <select name="method" aria-label="How" defaultValue={r.paidBy === 'UPI' ? 'UPI' : r.paidBy === 'CARD' ? 'CARD' : 'CASH'} className="mc-select-sm">
                <option value="CASH">Cash</option><option value="UPI">UPI</option><option value="CARD">Card reversal</option>
              </select>
              <Button>Handed back</Button>
            </form>
          ) },
        ]} />
      </Card>
      {day ? (
        <>
          <div className="mc-grid">
            {([['At the counter', day.totals.collectedAtCounter], ['Online', day.totals.collectedOnline], ['Refunded', day.totals.refunded], ['Unpaid (all days)', day.totals.outstanding]] as const).map(([label, n]) => (
              <Kpi key={label} label={label} value={inr(n)} icon={iconFor('', label)} />
            ))}
          </div>
          <Card title="Today's invoices">
            <Table rows={day.items} empty="No invoices today." columns={[
              { header: 'Invoice', cell: (i) => i.invoiceNo },
              { header: 'Patient', cell: (i) => <>{i.patient.name} <span className="mc-meta">{i.patient.mrn}</span></> },
              { header: 'For', cell: (i) => <span className="mc-meta">{i.description}</span> },
              { header: 'Total', cell: (i) => inr(i.total) },
              { header: 'Status', cell: (i) => <Badge tone={i.status === 'PAID' ? 'success' : i.status === 'ISSUED' ? 'warning' : 'neutral'}>{i.status.toLowerCase().replace('_', ' ')}</Badge> },
              { header: '', cell: (i) => (i.amountPaid > 0 ? <a href={`/desk/receipt/${i.id}`} target="_blank" rel="noreferrer">Receipt</a> : null) },
            ]} />
          </Card>
        </>
      ) : null}
    </ZoneFrame>
  );
}
