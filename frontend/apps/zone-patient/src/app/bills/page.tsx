import { getSession } from '@mc/auth';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Card, Kpi, PageHeader, Table } from '@mc/ui';
import { inr, INVOICE_STATUS, myInvoices } from '@/lib/billing';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const day = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Every invoice for the patient's account (self and family), with receipts and refunds. */

export default async function MyBills() {
  const caps = await zoneCapabilities('patient', '/care/bills');
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path="/care/bills" zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  const bills = await myInvoices(token);
  const due = (list: typeof bills) => list.reduce((n, b) => n + b.total - b.amountPaid, 0);
  return (
    <ZoneFrame zone="patient" path="/care/bills" zones={ZONES}>
      <PageHeader title="My bills" subtitle="Invoices and receipts for you and your family." />
      <div className="mc-kpis">
        <Kpi label="Paid" icon="receipt" tone="success" value={inr(bills.reduce((n, b) => n + b.amountPaid, 0))} sub={(() => { const n = bills.filter((b) => b.status === 'PAID').length; return `${n} bill${n === 1 ? '' : 's'} settled`; })()} />
        <Kpi label="To pay at the hospital" icon="building" value={inr(due(bills.filter((b) => b.status === 'ISSUED' && b.paymentMode === 'AT_CLINIC')))} sub="At the counter on the day" />
        <Kpi label="To pay online" icon="card" tone={bills.some((b) => b.status === 'ISSUED' && b.paymentMode === 'ONLINE') ? 'warning' : undefined} value={inr(due(bills.filter((b) => b.status === 'ISSUED' && b.paymentMode === 'ONLINE')))} sub="Pay from the list below" />
        <Kpi label="Refunded" icon="arrow" value={inr(bills.reduce((n, b) => n + b.amountRefunded, 0))} />
      </div>
      <Card>
        <Table
          rows={bills}
          empty="No bills yet."
          columns={[
            { header: 'Date', cell: (b) => day(b.issuedAt) },
            { header: 'Invoice', cell: (b) => <a href={`/care/bills/${b.id}`} data-testid={`bill-${b.invoiceNo}`}>{b.invoiceNo}</a> },
            { header: 'For', cell: (b) => <>{b.patient.name}<br /><span className="mc-meta">{b.description}</span></> },
            { header: 'Amount', cell: (b) => <>{inr(b.total)}{b.amountRefunded ? <><br /><span className="mc-meta">refunded {inr(b.amountRefunded)}</span></> : null}</> },
            { header: 'Status', cell: (b) => <Badge tone={INVOICE_STATUS[b.status]?.tone ?? 'neutral'}>{b.status === 'ISSUED' && b.paymentMode === 'AT_CLINIC' ? 'Pay at the hospital' : INVOICE_STATUS[b.status]?.label ?? b.status}</Badge> },
            {
              header: '', cell: (b) => (b.status === 'ISSUED' && b.paymentMode === 'ONLINE'
                ? <a className="mc-btn mc-btn-primary" href={`/care/pay/${b.id}`}>Pay now</a>
                : b.status === 'VOID' ? null : <a href={`/care/bills/${b.id}/pdf`}>{b.status === 'ISSUED' ? 'Invoice' : 'Receipt'} (PDF)</a>),
            },
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
