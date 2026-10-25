import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Card, PageHeader, Table } from '@mc/ui';
import { day, get, INVOICE, inr, type InvoiceRow, lastDay } from '@/lib/account';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const KIND: Record<string, string> = { FIRST: 'first month', RENEWAL: 'monthly', PRORATION: 'plan change' };

export default async function Invoices() {
  await zoneCapabilities('account', '/account/invoices');
  const rows = await get<InvoiceRow[]>('/invoices');
  return (
    <ZoneFrame zone="account" path="/account/invoices" zones={ZONES}>
      <PageHeader title="Invoices" subtitle="From MediCare, with GST." />
      <Card>
        <Table rows={rows} empty="No invoices yet." columns={[
          { header: 'Invoice', cell: (i) => <><a href={`/account/invoices/${i.id}`}><strong>{i.number}</strong></a><div className="mc-meta">{KIND[i.kind] ?? i.kind}</div></> },
          { header: 'Period', cell: (i) => `${day(i.periodStart)} – ${lastDay(i.periodEnd)}` },
          { header: 'Total', cell: (i) => inr(i.total) },
          { header: 'Status', cell: (i) => <><Badge tone={INVOICE[i.status].tone}>{INVOICE[i.status].label}</Badge>{i.lastError && i.status !== 'PAID' ? <div className="mc-meta">{i.lastError}</div> : null}</> },
        ]} />
      </Card>
    </ZoneFrame>
  );
}
