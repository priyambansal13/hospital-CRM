import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Card, PageHeader, Table } from '@mc/ui';
import { notFound } from 'next/navigation';
import { type InvoiceDetail, inr, INVOICE_STATUS } from '@/lib/billing';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : '');
const REFUND: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  PENDING: { label: 'being processed', tone: 'warning' }, SUBMITTING: { label: 'being processed', tone: 'warning' }, PROCESSING: { label: 'on its way to your account', tone: 'warning' },
  HAND_BACK: { label: 'collect it at the hospital counter', tone: 'warning' }, PROCESSED: { label: 'refunded', tone: 'success' }, FAILED: { label: 'delayed: the hospital is looking into it', tone: 'danger' },
};

/** E-8: one bill, with what was paid and every refund and where it stands. */
export default async function Bill({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await zoneCapabilities('patient', '/care/bills');
  const { accessToken: token } = (await getSession())!;
  const b = await api<InvoiceDetail>(`/api/billing/v1/invoices/${encodeURIComponent(id)}`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
  if (!b) notFound();
  return (
    <ZoneFrame zone="patient" path="/care/bills" zones={ZONES}>
      <PageHeader title={`Invoice ${b.invoiceNo}`} subtitle={`${b.patient.name} · ${b.description}`} actions={<a href="/care/bills">All bills</a>} />
      <Card>
        <p><Badge tone={INVOICE_STATUS[b.status]?.tone ?? 'neutral'}>{INVOICE_STATUS[b.status]?.label ?? b.status}</Badge> Total {inr(b.total)} · paid {inr(b.amountPaid)}{b.amountRefunded ? ` · refunded ${inr(b.amountRefunded)}` : ''}</p>
        {b.status !== 'VOID' ? <a href={`/care/bills/${b.id}/pdf`}>{b.status === 'ISSUED' ? 'Invoice' : 'Receipt'} (PDF)</a> : null}
      </Card>
      <Card title="Payments">
        <Table rows={b.payments.filter((p) => p.status === 'CAPTURED')} empty="Nothing paid yet." columns={[
          { header: 'When', cell: (p) => when(p.capturedAt) },
          { header: 'How', cell: (p) => `${p.channel === 'ONLINE' ? 'Online' : 'At the counter'}${p.method ? `, ${p.method.toUpperCase()}` : ''}` },
          { header: 'Amount', cell: (p) => inr(p.amount) },
        ]} />
      </Card>
      <Card title="Refunds">
        <Table rows={b.refunds} empty="No refunds." columns={[
          { header: 'Amount', cell: (r) => inr(r.amount) },
          { header: 'Why', cell: (r) => r.reason },
          { header: 'Where it stands', cell: (r) => <><Badge tone={REFUND[r.status]?.tone ?? 'neutral'}>{REFUND[r.status]?.label ?? r.status.toLowerCase()}</Badge>{r.processedAt ? <span className="mc-meta"> {when(r.processedAt)}</span> : null}</> },
        ]} />
        <p className="mc-meta">Online refunds usually reach your account in 5–7 working days.</p>
      </Card>
    </ZoneFrame>
  );
}
