import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Button, Card, PageHeader, Select } from '@mc/ui';
import { notFound } from 'next/navigation';
import { type Appointment, fmtDay, fmtTime } from '@/lib/booking';
import { simulatePayment, verifyPayment } from '@/lib/booking-actions';
import { inr, invoiceDetail } from '@/lib/billing';
import type { LabOrder } from '@/lib/lab';
import { myMembership } from '@/lib/membership';
import { Flash } from '@/lib/flash';
import { RazorpayButton } from '@/lib/razorpay-checkout';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const at = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Pay for an online booking (the slot is held meanwhile), then wait for the confirmation. */
export default async function PayPage({ params, searchParams }: { params: Promise<{ invoiceId: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { invoiceId } = await params;
  const path = `/care/pay/${invoiceId}`;
  const caps = await zoneCapabilities('patient', path);
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path={path} zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  const inv = await invoiceDetail(token, invoiceId).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  const isLab = inv.source.type === 'LAB_ORDER';
  const isMembership = inv.source.type === 'MEMBERSHIP';
  const appt = isLab || isMembership ? null : await api<Appointment & { holdExpiresAt: string | null; paymentStatus: string }>(`/api/scheduling/v1/appointments/${inv.source.id}`, { token }).catch(() => null);
  const lab = isLab ? await api<LabOrder>(`/api/diagnostics/v1/lab-orders/${inv.source.id}`, { token }).catch(() => null) : null;
  const sp = await searchParams;
  const paid = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(inv.status);
  const mem = isMembership ? await myMembership(token).catch(() => null) : null;
  const status = appt?.status ?? lab?.status ?? (isMembership ? (mem?.membership?.invoiceId === inv.id && mem.membership.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING_PAYMENT') : undefined);
  const confirming = paid && status === 'PENDING_PAYMENT';
  const lost = paid && status === 'EXPIRED';
  const minutesLeft = inv.payBy ? Math.max(0, Math.ceil((Date.parse(inv.payBy) - Date.now()) / 60_000)) : null;

  return (
    <ZoneFrame zone="patient" path={path} zones={ZONES}>
      {confirming ? <meta httpEquiv="refresh" content="2" /> : null}
      <PageHeader title={paid ? 'Payment' : isMembership ? 'Pay for your membership' : isLab ? 'Pay to confirm your lab booking' : 'Pay to confirm your appointment'} subtitle={`${inv.invoiceNo} · ${inv.patient.name}`} />
      <Flash ok={paid ? undefined : sp.ok} error={sp.error} />
      {appt ? (
        <Card title="Appointment">
          <dl className="mc-summary">
            <dt>Doctor</dt><dd>{appt.doctor.name}</dd>
            <dt>When</dt><dd>{fmtDay(appt.localDate, { weekday: 'long', day: 'numeric', month: 'long' })}, {fmtTime(appt.localTime)}</dd>
            <dt>Where</dt><dd>{appt.mode === 'VIDEO' ? 'Video consultation' : appt.branch.name}</dd>
            <dt>Amount</dt><dd>{inr(inv.total)}</dd>
          </dl>
        </Card>
      ) : null}
      {lab ? (
        <Card title="Lab tests">
          <dl className="mc-summary">
            <dt>Tests</dt><dd>{lab.lines.map((l) => l.name).join(' + ')}</dd>
            <dt>When</dt><dd>{lab.localDate ? `${fmtDay(lab.localDate, { weekday: 'long', day: 'numeric', month: 'long' })}, ${fmtTime(lab.localTime!)}` : '—'}</dd>
            <dt>Where</dt><dd>{lab.branch?.name}</dd>
            <dt>Amount</dt><dd>{inr(inv.total)}</dd>
          </dl>
        </Card>
      ) : null}

      {isMembership ? (
        <Card title="Membership">
          <dl className="mc-summary">
            <dt>For</dt><dd>{inv.description}</dd>
            <dt>Amount</dt><dd>{inr(inv.total)}</dd>
          </dl>
        </Card>
      ) : null}

      {inv.status === 'ISSUED' && inv.checkout ? (
        <Card title={`Pay ${inr(inv.total)}`}>
          <p className="mc-muted" style={{ marginTop: 0 }}>
            {isMembership ? `Your membership starts as soon as the payment goes through${inv.payBy ? ` (pay by ${at(inv.payBy)})` : ''}.` : <>We are holding this time for you{inv.payBy ? ` until ${at(inv.payBy)} (${minutesLeft} min)` : ''}. Your appointment is confirmed as soon as the payment goes through.</>}
          </p>
          {inv.payments.find((p) => p.lastError) ? <Alert tone="error">Last attempt failed: {inv.payments.find((p) => p.lastError)!.lastError}</Alert> : null}
          {inv.checkout.gateway === 'RAZORPAY' ? (
            <RazorpayButton keyId={inv.checkout.keyId} orderId={inv.checkout.orderId} amountPaise={Math.round(inv.total * 100)} hospital={inv.branch?.name ?? 'Membership'} description={inv.description} invoiceId={inv.id} label={`Pay ${inr(inv.total)}`} action={verifyPayment} />
          ) : (
            <form action={simulatePayment} className="mc-form">
              <input type="hidden" name="invoiceId" value={inv.id} />
              <input type="hidden" name="orderId" value={inv.checkout.orderId} />
              <Select label="Pay with (test payment)" name="method" options={[{ value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }, { value: 'netbanking', label: 'Net banking' }]} />
              <Button name="outcome" value="success">{`Pay ${inr(inv.total)}`}</Button>
              <Button name="outcome" value="failure" variant="ghost">Simulate a declined payment</Button>
              <small className="mc-muted mc-field-wide">Test mode: no real money moves. With Razorpay keys configured, this is Razorpay&apos;s payment page.</small>
            </form>
          )}
        </Card>
      ) : null}

      {inv.status === 'VOID' ? (
        <Card title="This payment window has closed">
          <p className="mc-muted">{isMembership ? <>Nothing was charged. <a href="/care/membership">Join again</a></> : <>The time was held for {inv.payBy ? 'a few minutes' : 'a while'} and has been released.</>} {appt ? <a href={`/care/doctors/${appt.doctor.id}`}>Book again</a> : null}</p>
        </Card>
      ) : null}

      {confirming ? <Alert tone="info">Payment received. Confirming your {isMembership ? 'membership' : isLab ? 'lab booking' : 'appointment'}…</Alert> : null}
      {paid && lab && ['BOOKED', 'SAMPLE_COLLECTED', 'IN_LAB'].includes(lab.status) ? (
        <Alert tone="success">Paid {inr(inv.amountPaid)}. Your lab visit {lab.orderNo} is booked.{lab.preparation ? ` Before you come: ${lab.preparation}.` : ''}</Alert>
      ) : null}
      {paid && appt && ['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'].includes(appt.status) ? (
        <Alert tone="success">Paid {inr(inv.amountPaid)}. Your appointment {appt.appointmentNo} is confirmed.</Alert>
      ) : null}
      {paid && isMembership && status === 'ACTIVE' ? <Alert tone="success">Paid {inr(inv.amountPaid)}. Welcome to {mem!.membership!.plan.name}! <a href="/care/membership">See your benefits</a></Alert> : null}
      {lost ? <Alert tone="error">Your payment arrived after the time was given to someone else, so we are refunding {inr(inv.amountPaid)} in full.</Alert> : null}
      {paid ? (
        <p><a className="mc-btn mc-btn-ghost" href={isMembership ? '/care/membership' : isLab ? '/care/lab-orders' : '/care/appointments'}>{isMembership ? 'My membership' : isLab ? 'My lab tests' : 'My appointments'}</a> <a className="mc-btn mc-btn-ghost" href={`/care/bills/${inv.id}/pdf`}>Download receipt (PDF)</a></p>
      ) : null}
    </ZoneFrame>
  );
}
