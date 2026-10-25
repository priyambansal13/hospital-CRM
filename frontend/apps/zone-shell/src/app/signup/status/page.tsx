import { api } from '@mc/bff';
import { ZoneFrame } from '@mc/features';
import { Alert, Badge, Card, PageHeader } from '@mc/ui';
import { type SignupStatus } from '@/lib/site';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** Setting up: each provisioning step as it completes (the page refreshes itself until the hospital is ready). */
export default async function Status({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const s = await api<SignupStatus>(`/api/tenant/v1/signup/status?token=${encodeURIComponent(token ?? '')}`).catch(() => null);
  const busy = s?.status === 'PROVISIONING';
  return (
    <ZoneFrame zone="shell" path="/signup/status" zones={ZONES} requireAuth={false}>
      {busy ? <meta httpEquiv="refresh" content="2" /> : null}
      <PageHeader title={s?.status === 'READY' ? `${s.hospitalName} is ready` : s ? `Setting up ${s.hospitalName}` : 'Signup'} subtitle={s ? s.url.replace(/^https?:\/\//, '') : undefined} />
      {!s ? <Alert tone="error">This link is not valid.</Alert> : null}
      {s?.error ? <Alert tone="error">{s.error}</Alert> : null}
      {s?.steps.length ? (
        <Card title="Steps">
          <ul role="list" aria-label="Setup steps" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {s.steps.map((x) => <li key={x.key} style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Badge tone={x.done ? 'success' : 'warning'}>{x.done ? 'done' : 'working'}</Badge>{x.label}</li>)}
          </ul>
        </Card>
      ) : busy ? <Card><p style={{ margin: 0 }}>Creating your hospital&apos;s database…</p></Card> : null}
      {s?.status === 'READY' ? (
        <Card title="Next">
          <p style={{ marginTop: 0 }}>Sign in with <strong>{s.email}</strong> and the setup guide takes you through branding, your first branch and doctor, opening hours and payments.</p>
          <a className="mc-btn mc-btn-primary" href={s.loginUrl!}>Sign in to {s.hospitalName}</a>
          <p className="mc-meta">Your patients&apos; booking page: <a href={`${s.url}/care`}>{s.url.replace(/^https?:\/\//, '')}/care</a></p>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
