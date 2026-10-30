import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, PageHeader, Table } from '@mc/ui';
import { applyCoupon, payNow, setCancel } from '@/lib/actions';
import { startCard } from '@/lib/card-actions';
import { resubscribe } from '@/lib/reactivate-actions';
import { day, get, inr, lastDay, STATUS, type Summary } from '@/lib/account';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** The hospital's MediCare subscription: status, what the next invoice will be, payment card, coupon, cancel. */
export default async function Subscription({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await zoneCapabilities('account', '/account');
  const s = await get<Summary>('/subscription').catch(() => null);
  if (!s) {
    return (
      <ZoneFrame zone="account" path="/account" zones={ZONES}>
        <PageHeader title="Subscription" />
        <Card><p style={{ margin: 0 }}>This account has no MediCare subscription.</p></Card>
      </ZoneFrame>
    );
  }
  const st = STATUS[s.status];
  const e = s.estimate;
  const card = s.paymentMethod?.kind === 'CARD' ? `${s.paymentMethod.brand} ending ${s.paymentMethod.last4}` : s.paymentMethod?.kind === 'OFFLINE' ? 'Bank transfer (invoices from MediCare)' : 'None';
  return (
    <ZoneFrame zone="account" path="/account" zones={ZONES}>
      <PageHeader title="Subscription" subtitle="What your hospital pays MediCare." actions={<Badge tone={st.tone}>{st.label}</Badge>} />
      <Flash {...await searchParams} />
      {s.clockOffsetDays ? <Alert tone="info">Test clock: {s.clockOffsetDays} days ahead ({day(s.now)}).</Alert> : null}
      {['EXPIRED', 'CANCELLED'].includes(s.status) ? (
        <Card title="Come back">
          <p style={{ marginTop: 0 }}>{s.status === 'EXPIRED' ? 'The free trial has ended.' : 'The subscription has ended.'} Everything you added is still here, read-only. {s.paymentMethod?.kind === 'CARD' ? 'Resubscribe to use it all again: this month is charged (prorated) to your card, plus any unpaid invoices.' : 'Add a card below, then resubscribe.'}</p>
          {s.paymentMethod?.kind === 'CARD' ? <form action={resubscribe}><Button>Resubscribe</Button></form> : null}
        </Card>
      ) : null}
      {s.unpaid.invoices ? (
        <Card title="Payment due">
          <p style={{ marginTop: 0 }}>{s.unpaid.invoices} unpaid invoice{s.unpaid.invoices > 1 ? 's' : ''}: <strong>{inr(s.unpaid.total)}</strong>.
            {s.status === 'GRACE' ? <> Pay by <strong>{day(s.graceEndsAt)}</strong> or the hospital becomes read-only.</> : s.status === 'PAST_DUE' ? <> We will try the card again on {day(s.nextRetryAt)}.</> : s.status === 'SUSPENDED' ? <> The hospital is read-only until they are paid.</> : null}</p>
          {s.paymentMethod?.kind === 'CARD' ? <form action={payNow}><Button>Pay {inr(s.unpaid.total)} now</Button></form> : <p className="mc-meta">Add a card below to pay.</p>}
        </Card>
      ) : null}
      <Card title={`${s.plan.name}`}>
        <dl className="mc-dl">
          {s.status === 'TRIALING' ? <><dt>Free trial</dt><dd>until <strong>{day(s.trialEndsAt)}</strong>{s.paymentMethod?.kind === 'CARD' ? ' — then your card is charged for the rest of that month' : ' — add a card to continue after it'}</dd></> : null}
          {s.periodEnd ? <><dt>This period</dt><dd>{day(s.periodStart)} – {lastDay(s.periodEnd)}{s.cancelAtPeriodEnd ? <> <Badge tone="warning">ends then</Badge></> : <span className="mc-meta"> · renews {day(s.periodEnd)}</span>}</dd></> : null}
          <dt>Add-ons</dt><dd>{s.addons.length ? s.addons.map((a) => `${a.name}${a.quantity > 1 ? ` × ${a.quantity}` : ''}`).join(', ') : 'None'}</dd>
          <dt>Payment</dt><dd>{card}</dd>
          {s.coupon ? <><dt>Coupon</dt><dd>{s.coupon.code}{s.coupon.invoicesLeft != null ? ` (${s.coupon.invoicesLeft} more invoice${s.coupon.invoicesLeft === 1 ? '' : 's'})` : ''}</dd></> : null}
          {s.pendingChange ? <><dt>Scheduled</dt><dd>Moves to {s.pendingChange.plan} on {day(s.periodEnd)}</dd></> : null}
        </dl>
      </Card>
      {e ? (
        <Card title="A month costs (before usage)">
          <Table rows={e.lines} empty="" columns={[
            { header: 'Item', cell: (l) => l.description },
            { header: 'Qty', cell: (l) => l.quantity },
            { header: 'Amount', cell: (l) => inr(l.amount) },
          ]} />
          <p style={{ marginBottom: 0 }}>{inr(e.subtotal)} + GST {e.gstPercent}% {inr(e.gst)} = <strong>{inr(e.total)}</strong> a month <span className="mc-meta">({e.quantities.doctor} doctors, {e.quantities.branch} branches today; usage beyond the allowance is added the next month)</span></p>
        </Card>
      ) : null}
      <Card title={s.paymentMethod?.kind === 'CARD' ? 'Change card' : 'Add a card'}>
        {s.cardPayments ? (
          <form action={startCard} aria-label="Card">
            <p style={{ marginTop: 0 }}>You enter the card on the payment gateway&apos;s secure page; MediCare never sees the number and keeps only the last 4 digits.</p>
            <Button>{s.paymentMethod?.kind === 'CARD' ? 'Change card' : `Add a card${s.unpaid.invoices ? ' and pay' : ''}`}</Button>
          </form>
        ) : <p style={{ margin: 0 }}>Card payments are not set up yet: MediCare sends invoices and you pay by bank transfer.</p>}
      </Card>
      {!s.coupon && ['TRIALING', 'ACTIVE'].includes(s.status) ? (
        <Card title="Coupon">
          <form action={applyCoupon} className="mc-inline" aria-label="Coupon"><input name="code" required placeholder="WELCOME20" aria-label="Coupon code" className="mc-input-sm" /><button className="mc-btn mc-btn-ghost">Apply</button></form>
        </Card>
      ) : null}
      {s.status === 'ACTIVE' ? (
        <Card title="Cancel">
          <form action={setCancel} className="mc-inline">
            <input type="hidden" name="cancel" value={s.cancelAtPeriodEnd ? '0' : '1'} />
            {s.cancelAtPeriodEnd ? <><span>The subscription ends on {day(s.periodEnd)}.</span> <Button variant="ghost">Keep it</Button></> : <><span className="mc-meta">Ends the subscription at the end of this period; after that records stay viewable, nothing new can be added.</span> <Button variant="danger">Cancel at period end</Button></>}
          </form>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
