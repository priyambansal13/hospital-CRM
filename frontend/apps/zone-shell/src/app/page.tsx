import { getSession } from '@mc/auth';
import { getBranding } from '@mc/bff';
import { getCapabilities, homeFor, visibleNav, ZoneFrame } from '@mc/features';
import { Alert, Card, Icon, iconFor, PageHeader } from '@mc/ui';
import { HospitalHome } from './hospital-home';
import { PlatformHome } from './platform-home';
import { redirect } from 'next/navigation';
import { PLATFORM_SLUG } from '@/lib/site';
import { ZONE_BASES, ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ denied?: string; reason?: string }> }) {
  const { denied } = await searchParams;
  const session = await getSession();
  if (!session) {
    const b = await getBranding();
    // MediCare's own site (what hospitals buy) or the hospital's site (what patients need first)
    return (
      <ZoneFrame zone="shell" path="/" zones={ZONES} requireAuth={false} wide>
        {b.slug === PLATFORM_SLUG ? <PlatformHome /> : <HospitalHome name={b.name} />}
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
      <PageHeader title="Welcome back" subtitle="Where would you like to go?" />
      <Card title="You're signed in">
        {nav.length ? (
          <div className="mc-tiles">{nav.map((n) => <a key={n.key} className="mc-tile" href={n.href}><span className="mc-tile-icon"><Icon name={iconFor(n.key, n.label)} /></span><strong>{n.label}</strong></a>)}</div>
        ) : (
          <p className="mc-muted">
            {caps.actor.kind === 'patient' ? 'Booking and your health records are coming soon to this portal.' : 'No areas are available for your role yet. Ask your hospital admin.'}
          </p>
        )}
      </Card>
    </ZoneFrame>
  );
}
