import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, Chip, Field, PageHeader, Table } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Invoice { id: string; invoiceNo: string; status: string; paymentMode: string; patient: { name: string; mrn: string }; description: string; total: number; amountPaid: number; amountRefunded: number; issuedAt: string; paidAt: string | null }
interface Day { date: string; totals: { collectedOnline: number; collectedAtCounter: number; refunded: number; outstanding: number; failedRefunds: number }; items: Invoice[] }

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { ISSUED: 'warning', PAID: 'success', PARTIALLY_REFUNDED: 'neutral', REFUNDED: 'neutral', VOID: 'neutral' };
const STATUSES = ['ISSUED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOID'];

/** The day's money: collected online and at the counter, refunds, and every invoice touched that day. */
export default async function Billing({ searchParams }: { searchParams: Promise<{ date?: string; status?: string; q?: string }> }) {
  await zoneCapabilities('admin', '/admin/billing');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const qs = new URLSearchParams(Object.entries({ date: sp.date, status: STATUSES.includes(sp.status ?? '') ? sp.status : undefined, q: sp.q }).filter(([, v]) => v) as [string, string][]);
  const day = await api<Day>(`/api/billing/v1/invoices?${qs}`, { token });
  const link = (status?: string) => `/admin/billing?${new URLSearchParams(Object.entries({ date: sp.date, q: sp.q, status }).filter(([, v]) => v) as [string, string][])}`;
  return (
    <ZoneFrame zone="admin" path="/admin/billing" zones={ZONES}>
      <PageHeader title="Billing" subtitle={new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day.date}T00:00:00Z`))} />
      {day.totals.failedRefunds ? <Alert tone="error">{day.totals.failedRefunds} refund(s) failed at the payment gateway and need attention.</Alert> : null}
      <div className="mc-grid">
        {([['Collected online', day.totals.collectedOnline], ['Collected at the counter', day.totals.collectedAtCounter], ['Refunded', day.totals.refunded], ['Outstanding (all days)', day.totals.outstanding]] as const).map(([label, n]) => (
          <Card key={label}><p className="mc-muted" style={{ margin: 0 }}>{label}</p><p className="mc-stat">{inr(n)}</p></Card>
        ))}
      </div>
      <Card>
        <form method="get" className="mc-form">
          <Field label="Date" name="date" type="date" defaultValue={day.date} />
          <Field label="Invoice no., patient or MRN" name="q" defaultValue={sp.q} />
          {sp.status ? <input type="hidden" name="status" value={sp.status} /> : null}
          <Button>Show</Button>
        </form>
        <div className="mc-chips" style={{ marginTop: 12 }}>
          <Chip href={link()} active={!sp.status}>All</Chip>
          {STATUSES.map((s) => <Chip key={s} href={link(s)} active={sp.status === s}>{s.toLowerCase().replace('_', ' ')}</Chip>)}
        </div>
      </Card>
      <Card title={`Invoices (${day.items.length})`}>
        <Table
          rows={day.items}
          empty="No invoices for this day."
          columns={[
            { header: 'Invoice', cell: (i) => <a href={`/admin/billing/${i.id}`}>{i.invoiceNo}</a> },
            { header: 'Patient', cell: (i) => <>{i.patient.name} <span className="mc-meta">{i.patient.mrn}</span></> },
            { header: 'For', cell: (i) => <span className="mc-meta">{i.description}</span> },
            { header: 'Total', cell: (i) => inr(i.total) },
            { header: 'Refunded', cell: (i) => (i.amountRefunded ? inr(i.amountRefunded) : '—') },
            { header: 'Paid', cell: (i) => (i.paidAt ? (i.paymentMode === 'ONLINE' ? 'online' : 'counter') : '—') },
            { header: 'Status', cell: (i) => <Badge tone={TONE[i.status] ?? 'neutral'}>{i.status.toLowerCase().replace('_', ' ')}</Badge> },
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
