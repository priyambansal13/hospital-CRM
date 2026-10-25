import { getBranding } from '@mc/bff';
import { Card } from '@mc/ui';
import { OtpForm } from './otp-form';

export const dynamic = 'force-dynamic';

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next = '/', error } = await searchParams;
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const b = await getBranding();
  const brand = { '--brand': b.branding.primaryColor ?? '#0f766e' } as React.CSSProperties;
  return (
    <main className="mc-login" style={brand}>
      <div className="mc-brand" style={{ justifyContent: 'center', fontSize: '1.25rem' }}>
        <span className="mc-logo-mark" aria-hidden>{b.name.slice(0, 1)}</span>
        <span>{b.name}</span>
      </div>
      {error ? <div role="alert" className="mc-alert mc-alert-error">{error}</div> : null}
      <Card title="Patients">
        <OtpForm next={safeNext} />
      </Card>
      <Card title="Doctors and staff">
        <p className="mc-muted" style={{ marginTop: 0 }}>Sign in with your hospital account.</p>
        <a className="mc-btn mc-btn-ghost" href={`/auth/staff?next=${encodeURIComponent(safeNext)}`}>Staff sign-in</a>
      </Card>
    </main>
  );
}
