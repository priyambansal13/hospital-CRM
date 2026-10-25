import { getSession } from '@mc/auth';
import { getBranding } from '@mc/bff';
import { getCapabilities, homeFor, visibleNav, ZoneFrame } from '@mc/features';
import { Alert, Card } from '@mc/ui';
import { redirect } from 'next/navigation';
import { PLATFORM_SLUG } from '@/lib/site';
import { ZONE_BASES, ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ denied?: string; reason?: string }> }) {
  const { denied } = await searchParams;
  const session = await getSession();
  if (!session) {
    const b = await getBranding();
    if (b.slug === PLATFORM_SLUG) {
      // MediCare's own site: what hospitals buy
      return (
        <ZoneFrame zone="shell" path="/" zones={ZONES} requireAuth={false}>
          <Card title="Run your hospital or clinic on MediCare">
            <p className="mc-muted">Online booking, front desk and queue, clinical records, lab and home collection, billing: one subscription, your own secure database.</p>
            <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <a className="mc-btn mc-btn-primary" href="/signup">Start a free trial</a>
              <a className="mc-btn mc-btn-ghost" href="/pricing">Plans and prices</a>
              <a className="mc-btn mc-btn-ghost" href="/login">MediCare staff sign-in</a>
            </p>
          </Card>
        </ZoneFrame>
      );
    }
    return (
      <ZoneFrame zone="shell" path="/" zones={ZONES} requireAuth={false}>
        <Card title={`Welcome to ${b.name}`}>
          <p className="mc-muted">Book appointments, see your reports and manage your visits.</p>
          <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <a className="mc-btn mc-btn-primary" href="/care">Find a doctor</a>
            <a className="mc-btn mc-btn-ghost" href="/login">Patient or staff sign-in</a>
          </p>
        </Card>
      </ZoneFrame>
    );
  }
  const caps = await getCapabilities('/');
  const home = homeFor(caps, ZONES.map((z) => z.name), ZONE_BASES);
  if (home !== '/' && !denied) redirect(home);
  const nav = visibleNav(caps, ZONES.map((z) => z.name));
  return (
    <ZoneFrame zone="shell" path="/" zones={ZONES}>
      {denied ? <Alert tone="error">You don&apos;t have access to that area.</Alert> : null}
      <Card title="You're signed in">
        {nav.length ? (
          <ul>{nav.map((n) => <li key={n.key}><a href={n.href}>{n.label}</a></li>)}</ul>
        ) : (
          <p className="mc-muted">
            {caps.actor.kind === 'patient' ? 'Booking and your health records are coming soon to this portal.' : 'No areas are available for your role yet. Ask your hospital admin.'}
          </p>
        )}
      </Card>
    </ZoneFrame>
  );
}
