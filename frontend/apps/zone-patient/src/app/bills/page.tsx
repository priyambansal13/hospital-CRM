import { getSession } from '@mc/auth';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Card, PageHeader, Table } from '@mc/ui';
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
  return (
    <ZoneFrame zone="patient" path="/care/bills" zones={ZONES}>
      <PageHeader title="My bills" subtitle="Invoices and receipts for you and your family." />
      <Card>
        <Table
          rows={bills}
          empty="No bills yet."
          columns={[
            { header: 'Date', cell: (b) => day(b.issuedAt) },
            { header: 'Invoice', cell: (b) => <span data-testid={`bill-${b.invoiceNo}`}>{b.invoiceNo}</span> },
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
