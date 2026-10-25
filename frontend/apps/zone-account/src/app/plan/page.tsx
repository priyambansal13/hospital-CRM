import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, PageHeader } from '@mc/ui';
import { changePlan } from '@/lib/actions';
import { day, get, inr, type PlanChoice, type Summary } from '@/lib/account';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** Change plan: an upgrade applies now (the rest of the month is invoiced at once); a downgrade at the period end. */
export default async function ChangePlan({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await zoneCapabilities('account', '/account/plan');
  const [s, c] = await Promise.all([get<Summary>('/subscription'), get<{ quantities: { doctor: number; branch: number }; gstPercent: number; plans: PlanChoice[] }>('/plans')]);
  const current = c.plans.find((p) => p.current);
  return (
    <ZoneFrame zone="account" path="/account/plan" zones={ZONES}>
      <PageHeader title="Change plan" subtitle={`Prices for your ${c.quantities.doctor} doctors and ${c.quantities.branch} branches, a month, before GST (${c.gstPercent}%).`} />
      <Flash {...await searchParams} />
      {s.pendingChange ? <Card><p style={{ margin: 0 }}>Scheduled: moves to <strong>{s.pendingChange.plan}</strong> on {day(s.periodEnd)}.</p></Card> : null}
      <div className="mc-grid">
        {c.plans.map((p) => {
          const up = !current || p.monthly > current.monthly;
          return (
            <Card key={p.code} title={p.name}>
              <p className="mc-meta" style={{ marginTop: 0 }}>{p.edition} · {p.tier}</p>
              <p className="mc-stat" style={{ fontSize: '1.5rem' }}>{inr(p.monthly)}<span className="mc-meta"> / month</span></p>
              <p className="mc-meta">{p.modules.join(', ')}</p>
              {p.current ? <Badge tone="success">your plan</Badge> : (
                <form action={changePlan} aria-label={`Choose ${p.name}`}>
                  <input type="hidden" name="plan" value={p.code} />
                  <Button variant={up ? 'primary' : 'ghost'}>{s.status === 'TRIALING' ? 'Switch' : up ? 'Upgrade now' : 'Downgrade at period end'}</Button>
                </form>
              )}
            </Card>
          );
        })}
      </div>
    </ZoneFrame>
  );
}
