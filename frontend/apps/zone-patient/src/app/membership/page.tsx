import { getSession } from '@mc/auth';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, Icon, PageHeader } from '@mc/ui';
import { inr } from '@/lib/billing';
import { Flash } from '@/lib/flash';
import { myMembership, perks } from '@/lib/membership';
import { joinMembership } from '@/lib/membership-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const day = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** The hospital's membership tiers: compare, join or renew (paid like any bill), and what the current one gives. */
export default async function MembershipPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const path = '/care/membership';
  const caps = await zoneCapabilities('patient', path);
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path={path} zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  const { membership: m, pending, plans } = await myMembership(token);
  const active = m && m.status === 'ACTIVE' ? m : null;
  const daysLeft = active?.endsAt ? Math.max(0, Math.ceil((Date.parse(active.endsAt) - Date.now()) / 86_400_000)) : null;

  return (
    <ZoneFrame zone="patient" path={path} zones={ZONES}>
      <PageHeader title="Membership" subtitle="Book further ahead, get members-only times, free video consultations and lab discounts." />
      <Flash {...await searchParams} />
      {active ? (
        <Card title={`You are a ${active.plan.name} member`}>
          <p className="mc-muted" style={{ marginTop: 0 }}>Valid until {day(active.endsAt!)}{daysLeft !== null ? ` (${daysLeft} day${daysLeft === 1 ? '' : 's'} left)` : ''}. Renewing adds another {active.plan.period === 'YEARLY' ? 'year' : 'month'} from that date.</p>
          <ul className="mc-perks">{perks(active.plan.benefits).map((p) => <li key={p}><Icon name="shield" /> {p}</li>)}</ul>
        </Card>
      ) : m ? <Alert tone="info">Your {m.plan.name} membership {m.status === 'CANCELLED' ? 'was cancelled' : `ended on ${day(m.endsAt!)}`}. Join again below.</Alert> : null}
      {pending?.invoiceId ? <Alert tone="info">Your {pending.plan.name} membership is waiting for payment. <a href={`/care/pay/${pending.invoiceId}`}>Pay now</a></Alert> : null}

      {plans.length ? (
        <div className="mc-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }} aria-label="Membership tiers">
          {plans.map((t) => {
            const mine = active?.plan.code === t.code;
            return (
              <Card key={t.id} title={t.name}>
                <p style={{ margin: '0 0 8px' }}><strong style={{ fontSize: '1.6rem' }}>{inr(t.price)}</strong> <span className="mc-muted">/ {t.period === 'YEARLY' ? 'year' : 'month'}</span> {mine ? <Badge tone="success">Your tier</Badge> : null}</p>
                {t.description ? <p className="mc-muted">{t.description}</p> : null}
                <ul className="mc-perks">{perks(t.benefits).map((p) => <li key={p}><Icon name="shield" /> {p}</li>)}</ul>
                {active && !mine ? <p className="mc-meta">You can switch when your {active.plan.name} membership ends.</p> : (
                  <form action={joinMembership}>
                    <input type="hidden" name="planId" value={t.id} />
                    <Button>{mine ? `Renew ${t.name}` : `Join ${t.name}`}</Button>
                  </form>
                )}
              </Card>
            );
          })}
        </div>
      ) : <Card><p className="mc-empty">The hospital has not set up membership tiers yet.</p></Card>}
    </ZoneFrame>
  );
}
