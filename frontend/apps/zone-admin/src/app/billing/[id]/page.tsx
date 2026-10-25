import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { refundInvoice } from '../actions';

export const dynamic = 'force-dynamic';

interface Detail {
  id: string; invoiceNo: string; status: string; paymentMode: string; description: string; patient: { name: string; mrn: string }; branch: { name: string };
  total: number; amountPaid: number; amountRefunded: number; issuedAt: string; voidReason: string | null;
  payments: { id: string; channel: string; gateway: string; amount: number; method: string | null; reference: string | null; status: string; gatewayPaymentId: string | null; lastError: string | null; capturedAt: string | null; createdAt: string }[];
  refunds: { id: string; amount: number; reason: string; status: string; gatewayRefundId: string | null; createdAt: string; processedAt: string | null }[];
}
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : '—');

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const caps = await zoneCapabilities('admin', `/admin/billing/${id}`);
  const { accessToken: token } = (await getSession())!;
  const inv = await api<Detail>(`/api/billing/v1/invoices/${encodeURIComponent(id)}`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  const refundable = Math.round((inv.amountPaid - inv.refunds.filter((r) => r.status !== 'FAILED' && r.reason !== 'Duplicate payment').reduce((s, r) => s + r.amount, 0)) * 100) / 100;
  return (
    <ZoneFrame zone="admin" path={`/admin/billing/${id}`} zones={ZONES}>
      <PageHeader title={inv.invoiceNo} subtitle={`${inv.patient.name} (${inv.patient.mrn}) · ${inv.branch.name}`} actions={<a className="mc-btn mc-btn-ghost" href={`/admin/billing/${inv.id}/pdf`}>PDF</a>} />
      <Flash {...await searchParams} />
      <Card title="Invoice">
        <dl className="mc-summary">
          <dt>For</dt><dd>{inv.description}</dd>
          <dt>Total</dt><dd>{inr(inv.total)} ({inv.paymentMode === 'ONLINE' ? 'online booking' : 'pay at the hospital'})</dd>
          <dt>Status</dt><dd><Badge>{inv.status.toLowerCase().replace('_', ' ')}</Badge>{inv.voidReason ? ` (${inv.voidReason.toLowerCase().replaceAll('_', ' ')})` : ''}</dd>
          <dt>Paid / refunded</dt><dd>{inr(inv.amountPaid)} / {inr(inv.amountRefunded)}</dd>
          <dt>Issued</dt><dd>{when(inv.issuedAt)}</dd>
        </dl>
      </Card>
      <Card title="Payments">
        <Table rows={inv.payments} empty="No payments." columns={[
          { header: 'When', cell: (p) => when(p.capturedAt ?? p.createdAt) },
          { header: 'How', cell: (p) => `${p.channel === 'ONLINE' ? `online (${p.gateway.toLowerCase()})` : 'counter'}${p.method ? `, ${p.method}` : ''}${p.reference ? ` · ${p.reference}` : ''}` },
          { header: 'Amount', cell: (p) => inr(p.amount) },
          { header: 'Status', cell: (p) => <>{p.status.toLowerCase()}{p.lastError ? <span className="mc-meta"> · last attempt: {p.lastError}</span> : null}</> },
          { header: 'Gateway id', cell: (p) => <span className="mc-meta">{p.gatewayPaymentId ?? '—'}</span> },
        ]} />
      </Card>
      <Card title="Refunds">
        <Table rows={inv.refunds} empty="No refunds." columns={[
          { header: 'Requested', cell: (r) => when(r.createdAt) },
          { header: 'Reason', cell: (r) => r.reason },
          { header: 'Amount', cell: (r) => inr(r.amount) },
          { header: 'Status', cell: (r) => <Badge tone={r.status === 'FAILED' ? 'danger' : r.status === 'PROCESSED' ? 'success' : 'warning'}>{r.status.toLowerCase()}</Badge> },
          { header: 'Done', cell: (r) => when(r.processedAt) },
        ]} />
      </Card>
      {can(caps, 'refund:create:branch') && refundable > 0 ? (
        <Card title="Issue a refund">
          <form action={refundInvoice} className="mc-form">
            <input type="hidden" name="invoiceId" value={inv.id} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <Field label={`Amount (up to ${inr(refundable)})`} name="amount" type="number" required defaultValue={String(refundable)} />
            <Field label="Reason" name="reason" required placeholder="e.g. goodwill, wrong fee charged" />
            <Button variant="danger">Refund</Button>
          </form>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
