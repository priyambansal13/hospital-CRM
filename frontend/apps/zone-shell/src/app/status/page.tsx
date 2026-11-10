import { pageMeta } from '@mc/features/seo';
import { type PlatformStatus, platformStatus, STATE_TEXT } from '@mc/features/status';
import type { Metadata } from 'next';
import { Badge, Card, PageHeader } from '@mc/ui';
import { MarketingFrame, marketingOnly } from '@/lib/marketing-frame';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  await marketingOnly();
  return { ...(await pageMeta({ title: 'MediCare status', description: 'Whether MediCare is working right now: sign-in, booking, records, lab, payments and messages, with any incidents and planned maintenance.', path: '/status', index: false })), other: { refresh: '60' } };
}

const when = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const IMPACT = { MINOR: 'warning', MAJOR: 'danger', CRITICAL: 'danger', MAINTENANCE: 'neutral' } as const;

/**
 * MediCare's public status page (docs/OPERATIONS.md §5). Also published as static files to a bucket every minute
 * (`mc status publish`), so a copy answers at status.<domain> when the platform itself is down.
 */
export default async function Status() {
  await marketingOnly();
  const s: PlatformStatus | null = await platformStatus().catch(() => null);
  const open = s?.incidents.filter((i) => i.status !== 'RESOLVED') ?? [];
  const past = s?.incidents.filter((i) => i.status === 'RESOLVED') ?? [];
  const names = Object.fromEntries((s?.components ?? []).map((c) => [c.key, c.name]));
  return (
    <MarketingFrame path="/status" wide={false}>
      <PageHeader title="MediCare status" subtitle={s ? `Checked ${when(s.updatedAt)} IST · refreshes every minute` : 'Status is unavailable right now'} />
      {s ? (
        <>
          <Card>
            <p style={{ margin: 0, fontSize: '1.15rem' }}><Badge tone={STATE_TEXT[s.overall].tone}>{s.overall === 'operational' ? 'All systems working' : STATE_TEXT[s.overall].label}</Badge></p>
          </Card>
          {open.map((i) => (
            <Card key={i.id} title={i.title}>
              <p className="mc-meta" style={{ marginTop: 0 }}><Badge tone={IMPACT[i.impact]}>{i.impact === 'MAINTENANCE' ? 'planned maintenance' : i.impact.toLowerCase()}</Badge> {i.status.toLowerCase()} · since {when(i.startsAt)}{i.endsAt ? ` until ${when(i.endsAt)}` : ''} · {i.components.map((c) => names[c] ?? c).join(', ')}</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{i.updates.map((u, n) => <li key={n}><strong>{u.status.toLowerCase()}</strong> ({when(u.at)}): {u.message}</li>)}</ul>
            </Card>
          ))}
          <Card title="Components">
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {s.components.map((c) => <li key={c.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>{c.name}</span><Badge tone={STATE_TEXT[c.state].tone}>{STATE_TEXT[c.state].label}</Badge></li>)}
            </ul>
          </Card>
          <Card title="Past 14 days">
            {past.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{past.map((i) => <li key={i.id}><strong>{i.title}</strong> <span className="mc-meta">{when(i.startsAt)} – {i.resolvedAt ? when(i.resolvedAt) : ''}</span>{i.updates[0] ? <div className="mc-meta">{i.updates[0].message}</div> : null}</li>)}</ul> : <p className="mc-meta" style={{ margin: 0 }}>No incidents.</p>}
          </Card>
        </>
      ) : <Card><p style={{ margin: 0 }}>We can&apos;t check right now. {process.env.STATUS_COPY_URL ? <>A copy of this page that doesn&apos;t depend on MediCare is at <a href={process.env.STATUS_COPY_URL}>{process.env.STATUS_COPY_URL}</a>.</> : 'Please try again in a minute.'}</p></Card>}
    </MarketingFrame>
  );
}
