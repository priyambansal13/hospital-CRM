import { getBranding } from '@mc/bff';
import { Card, Icon } from '@mc/ui';
import { OtpForm } from './otp-form';

export const dynamic = 'force-dynamic';

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next = '/', error } = await searchParams;
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const b = await getBranding();
  const brand = { '--brand': b.branding.primaryColor ?? '#0f766e' } as React.CSSProperties;
  const isPlatform = b.slug === (process.env.PLATFORM_TENANT_SLUG ?? 'medicare');
  const perks = isPlatform
    ? [['layers', 'Plans, prices and customers in one console'], ['shield', 'Every change in the audit log'], ['chart', 'Usage and billing at a glance']]
    : [['calendar', 'Book a doctor in a minute, pay online or at the hospital'], ['file', 'Reports and prescriptions as soon as they are ready'], ['chat', 'Ask us anything, any time: a person is one tap away']];
  return (
    <main className="mc-auth" style={{ ...brand, '--accent': b.branding.accentColor ?? '#f59e0b' } as React.CSSProperties}>
      <section className="mc-auth-side" aria-label={b.name}>
        <a className="mc-brand" href="/" style={{ color: '#fff', fontSize: '1.15rem' }}>
          <span className="mc-logo-mark" aria-hidden style={{ background: 'rgba(255,255,255,.18)', boxShadow: 'none' }}>{b.name.slice(0, 1)}</span>
          <span>{b.name}</span>
        </a>
        <div>
          <h1>{isPlatform ? 'Welcome back to MediCare.' : 'Your health, one sign-in away.'}</h1>
          <ul className="mc-auth-perks">
            {perks.map(([icon, text]) => <li key={text}><span><Icon name={icon} size={18} /></span>{text}</li>)}
          </ul>
        </div>
        <p className="mc-auth-foot">{isPlatform ? 'MediCare staff only.' : <>In an emergency, call <a href="tel:112">112</a> or <a href="tel:108">108</a>.</>}</p>
      </section>
      <section className="mc-auth-form">
        <div className="mc-login">
          <div>
            <h2 style={{ fontSize: '1.5rem', margin: 0 }}>Sign in</h2>
            <p className="mc-muted">Patients use their mobile number; doctors and staff, their hospital account.</p>
          </div>
          {error ? <div role="alert" className="mc-alert mc-alert-error">{error}</div> : null}
          <Card title="Patients">
            <OtpForm next={safeNext} />
          </Card>
          <Card title="Doctors and staff">
            <p className="mc-muted" style={{ marginTop: 0 }}>Sign in with your hospital account.</p>
            <a className="mc-btn mc-btn-ghost" href={`/auth/staff?next=${encodeURIComponent(safeNext)}`}>Staff sign-in</a>
          </Card>
        </div>
      </section>
    </main>
  );
}
