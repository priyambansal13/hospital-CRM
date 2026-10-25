import { ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Card, PageHeader, Table } from '@mc/ui';
import { notFound } from 'next/navigation';
import { day, get, INVOICE, inr, type InvoiceDetail, lastDay } from '@/lib/account';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

export default async function Invoice({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const path = `/account/invoices/${id}`;
  await zoneCapabilities('account', path);
  const i = await get<InvoiceDetail>(`/invoices/${encodeURIComponent(id)}`).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  const st = INVOICE[i.status];
  return (
    <ZoneFrame zone="account" path={path} zones={ZONES}>
      <PageHeader title={`Invoice ${i.number}`} subtitle={`${i.plan.name} · ${day(i.periodStart)} – ${lastDay(i.periodEnd)} · issued ${day(i.issuedAt)}`} actions={<><Badge tone={st.tone}>{st.label}</Badge><a className="mc-btn mc-btn-ghost" href="/account/invoices">All invoices</a></>} />
      <Card>
        <Table rows={i.lines} empty="" columns={[
          { header: 'Item', cell: (l) => l.description },
          { header: 'Qty', cell: (l) => l.quantity.toLocaleString('en-IN') },
          { header: 'Rate', cell: (l) => inr(l.unitPrice) },
          { header: 'Amount', cell: (l) => inr(l.amount) },
        ]} />
        <dl className="mc-dl" style={{ marginTop: 12 }}>
          <dt>Subtotal</dt><dd>{inr(i.subtotal)}</dd>
          {i.discount ? <><dt>Discount</dt><dd>−{inr(i.discount)} <span className="mc-meta">{i.discountLabel}</span></dd></> : null}
          <dt>GST {i.gstPercent}%</dt><dd>{inr(i.gst)}</dd>
          <dt>Total</dt><dd><strong>{inr(i.total)}</strong></dd>
          {i.paidAt ? <><dt>Paid</dt><dd>{day(i.paidAt)}</dd></> : null}
          {i.lastError && i.status !== 'PAID' ? <><dt>Last attempt</dt><dd>{i.lastError}</dd></> : null}
        </dl>
      </Card>
    </ZoneFrame>
  );
}
