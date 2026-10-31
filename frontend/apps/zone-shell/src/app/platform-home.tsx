import { Icon } from '@mc/ui';
import { inr, type PublicPlan, publicPlans } from '@/lib/site';

/** MediCare's own home page (the platform account's host): what hospitals buy, with the live plan catalogue. */
const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: 'calendar', title: 'Online booking that fills slots', text: 'Patients find a doctor by symptom, see the next free time and pay online; waitlists and reminders handle the rest.' },
  { icon: 'queue', title: 'Front desk and live queue', text: 'Walk-ins, tokens, check-in and a live queue screen; cash and card collection with receipts.' },
  { icon: 'clipboard', title: 'Clinical records', text: 'Visit notes, ICD-10 diagnoses, prescriptions with allergy and interaction checks, encrypted per hospital.' },
  { icon: 'flask', title: 'Lab and home collection', text: 'Orders, barcodes, results with ranges, critical-value escalation, verified PDF reports with QR checks.' },
  { icon: 'sparkles', title: 'AI that stays safe', text: 'A 24×7 patient assistant that books with Confirm cards, a doctor copilot with cited summaries, an AI scribe.' },
  { icon: 'shield', title: 'Your own secure database', text: 'One database per hospital, field encryption, an audit trail patients can see, offboarding with export.' },
];

export async function PlatformHome() {
  const plans = await publicPlans().catch(() => [] as PublicPlan[]);
  const shown = [...plans].sort((a, b) => a.listPrice - b.listPrice).slice(0, 3);
  const featured = shown[1]?.code;
  return (
    <>
      <section className="mc-hero" aria-label="MediCare">
        <div className="mc-hero-inner">
          <div>
            <span className="mc-eyebrow"><i aria-hidden />Built for Indian hospitals and clinics</span>
            <h1>Run your hospital on <em>one</em> calm system.</h1>
            <p className="mc-lead">Booking, front desk, records, lab, billing and AI assistance in one subscription, with your own secure database. Live in an afternoon.</p>
            <div className="mc-actions">
              <a className="mc-btn mc-btn-primary mc-btn-lg" href="/signup">Start a free trial</a>
              <a className="mc-btn mc-btn-ghost mc-btn-lg" href="/pricing">Plans and prices</a>
            </div>
            <div className="mc-hero-tags"><span>No card needed for the trial · Cancel any time · Data export included</span></div>
          </div>
          <div className="mc-hero-card" aria-label="A day at a clinic on MediCare">
            <h3>Today at City Care</h3>
            <div className="mc-kpis" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div className="mc-kpi"><span className="mc-kpi-label"><span className="mc-kpi-icon"><Icon name="calendar" /></span>Booked online</span><span className="mc-kpi-value">128</span></div>
              <div className="mc-kpi" data-tone="success"><span className="mc-kpi-label"><span className="mc-kpi-icon"><Icon name="queue" /></span>Seen on time</span><span className="mc-kpi-value">94%</span></div>
            </div>
            <div className="mc-bars">
              {[['Cardiology', 82], ['General Medicine', 64], ['Dermatology', 47]].map(([l, v]) => (
                <div key={l} className="mc-bar"><span>{l}</span><div className="mc-bar-track"><div className="mc-bar-fill" style={{ width: `${v}%` }} /></div><strong>{v}%</strong></div>
              ))}
            </div>
            <span className="mc-meta">Illustration: slots filled per department</span>
          </div>
        </div>
      </section>

      <section className="mc-section" aria-label="What is included">
        <div className="mc-section-head"><div><span className="mc-kicker">Everything in one place</span><h2>What your teams get</h2></div></div>
        <div className="mc-features">
          {FEATURES.map((f) => (
            <div key={f.title} className="mc-feature">
              <span className="mc-tile-icon"><Icon name={f.icon} /></span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      {shown.length ? (
        <section className="mc-section" aria-label="Plans">
          <div className="mc-section-head">
            <div><span className="mc-kicker">Simple pricing</span><h2>Pick a plan, switch any time</h2></div>
            <a className="mc-btn mc-btn-ghost" href="/pricing">Compare all plans</a>
          </div>
          <div className="mc-plans">
            {shown.map((p) => (
              <div key={p.code} className="mc-plan" data-featured={p.code === featured}>
                {p.code === featured ? <span className="mc-badge mc-badge-success" style={{ justifySelf: 'start' }}>Most popular</span> : null}
                <h3 style={{ margin: 0 }}>{p.name}</h3>
                <div className="mc-price">{inr(p.listPrice)}<span className="mc-meta" style={{ fontSize: 14, fontWeight: 600 }}> / month</span></div>
                <span className="mc-meta">{p.trialDays ? `${p.trialDays}-day free trial` : 'No trial'}</span>
                <ul>{p.modules.slice(0, 6).map((m) => <li key={m.key}>{m.name}</li>)}</ul>
                <a className={`mc-btn ${p.code === featured ? 'mc-btn-primary' : 'mc-btn-ghost'}`} href={`/signup?plan=${p.code}`}>Start with {p.name}</a>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="mc-band">
        <div className="mc-band-inner">
          <div>
            <h2>Your hospital, live today.</h2>
            <p>Sign up, confirm your e-mail and the setup guide walks you through branches, doctors and timings.</p>
          </div>
          <div className="mc-actions">
            <a className="mc-btn mc-btn-ghost mc-btn-lg" href="/signup">Start a free trial</a>
            <a className="mc-btn mc-btn-ghost mc-btn-lg" href="/login">MediCare staff sign-in</a>
          </div>
        </div>
      </div>
      <div style={{ height: 56 }} />
    </>
  );
}
