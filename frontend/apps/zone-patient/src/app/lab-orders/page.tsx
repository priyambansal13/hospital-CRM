import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, PageHeader } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { cancelLab } from '@/lib/health-actions';
import { VISIT_TEXT } from '@/lib/home';
import { LAB_STATUS, type LabOrder } from '@/lib/lab';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const when = (o: LabOrder) => (o.localDate ? `${new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${o.localDate}T00:00:00Z`))}, ${o.localTime}` : null);

/** Lab bookings for the account, with what to do before the visit. */
export default async function MyLabOrders({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('patient', '/care/lab-orders');
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path="/care/lab-orders" zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  const orders = await api<LabOrder[]>('/api/diagnostics/v1/me/lab-orders', { token });
  return (
    <ZoneFrame zone="patient" path="/care/lab-orders" zones={ZONES}>
      <PageHeader title="My lab tests" actions={<a className="mc-btn mc-btn-primary" href="/care/tests">Book tests</a>} />
      <Flash {...await searchParams} />
      {!orders.length ? <Card><p className="mc-empty">No lab tests yet.</p></Card> : null}
      {orders.map((o) => {
        const s = LAB_STATUS[o.status] ?? { label: o.status, tone: 'neutral' as const };
        return (
          <article key={o.id} className="mc-card mc-appt" aria-label={`Lab order ${o.orderNo}`}>
            <div>
              <h3>{o.lines.map((l) => l.name).join(' + ')}</h3>
              <p className="mc-meta" style={{ margin: '4px 0 0' }}>For {o.patient.name} · {o.orderNo} · ₹{o.total} {o.paymentStatus === 'PAID' ? 'paid' : o.paymentStatus === 'REFUNDED' ? 'refunded' : o.paymentMode === 'AT_CLINIC' ? (o.collectionType === 'HOME' ? 'to pay the collector' : 'to pay at the lab') : ''}</p>
              {when(o) && o.collectionType !== 'HOME' ? <p className="mc-meta" style={{ margin: '2px 0 0' }}>{when(o)} at {o.branch?.name}</p> : null}
              {o.collectionType === 'HOME' && o.homeAddress ? <p className="mc-meta" style={{ margin: '2px 0 0' }}>{o.homeVisit?.status === 'MISSED' ? 'Home collection' : `${when(o)}, at home`}: {[o.homeAddress.line1, o.homeAddress.landmark, o.homeAddress.pincode].filter(Boolean).join(', ')}</p> : null}
              {o.homeVisit && !['CANCELLED'].includes(o.homeVisit.status) && !['CANCELLED', 'EXPIRED', 'PENDING_PAYMENT'].includes(o.status) ? (
                <p style={{ margin: '6px 0 0' }} aria-label="Home visit">
                  <strong>{['ASSIGNED', 'EN_ROUTE', 'ARRIVED'].includes(o.homeVisit.status) && o.homeVisit.phlebotomistName ? `${o.homeVisit.phlebotomistName} ${VISIT_TEXT[o.homeVisit.status]}` : VISIT_TEXT[o.homeVisit.status] ?? o.homeVisit.status}</strong>
                  {o.homeVisit.status === 'MISSED' ? ` (${o.homeVisit.missedReason}). Please pick a new time; there is no extra charge.` : ''}
                </p>
              ) : null}
              {o.orderedBy ? <p className="mc-meta" style={{ margin: '2px 0 0' }}>Ordered by {o.orderedBy.name}</p> : null}
              {o.preparation && ['BOOKED', 'PENDING_PAYMENT', 'AWAITING_BOOKING'].includes(o.status) ? <p style={{ margin: '6px 0 0' }}><strong>Before you come:</strong> {o.preparation}</p> : null}
              {o.status === 'SAMPLE_REJECTED' ? <p style={{ margin: '6px 0 0' }}>The lab needs a new sample, at no extra charge. Visit the lab any day during collection hours, or <a href={`/care/tests/book?orderId=${o.id}`}>pick a time{o.collectionType === 'HOME' ? ' for a home visit' : ''}</a>.</p> : null}
            </div>
            <div className="mc-appt-actions">
              <Badge tone={s.tone}>{s.label}</Badge>
              {o.status === 'REPORT_PUBLISHED' ? <><a className="mc-btn mc-btn-primary" href={`/care/lab-orders/${o.id}`}>View results</a><a className="mc-btn mc-btn-ghost" href={`/care/lab-orders/${o.id}/report`}>Download report</a></> : null}
              {o.status === 'AWAITING_BOOKING' ? <a className="mc-btn mc-btn-primary" href={`/care/tests/book?orderId=${o.id}${o.collectionType === 'HOME' ? '&where=home' : ''}`}>{o.homeVisit?.status === 'MISSED' ? 'Pick a new time' : 'Pick a time'}</a> : null}
              {o.status === 'PENDING_PAYMENT' && o.invoiceId ? <a className="mc-btn mc-btn-primary" href={`/care/pay/${o.invoiceId}`}>Pay now</a> : null}
              {['AWAITING_BOOKING', 'PENDING_PAYMENT', 'BOOKED'].includes(o.status) && !['EN_ROUTE', 'ARRIVED'].includes(o.homeVisit?.status ?? '') ? (
                <form action={cancelLab}><input type="hidden" name="orderId" value={o.id} /><Button variant="ghost">Cancel</Button></form>
              ) : null}
            </div>
          </article>
        );
      })}
    </ZoneFrame>
  );
}
