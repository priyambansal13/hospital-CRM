import { getBranding } from '@mc/bff';
import { JsonLd, pageMeta } from '@mc/features/seo';
import type { Metadata } from 'next';
import { Badge, Card, PageHeader } from '@mc/ui';
import { inr, PLATFORM_SLUG, publicPlans } from '@/lib/site';
import { PRICING_FAQ } from '@/lib/marketing';
import { MarketingFrame } from '@/lib/marketing-frame';

export const dynamic = 'force-dynamic';

/** Indexed on MediCare's own host only (a hospital's host is about the hospital). */
export async function generateMetadata(): Promise<Metadata> {
  const b = await getBranding();
  return pageMeta({ title: 'MediCare plans and prices · Clinic, diagnostic centre and hospital software', description: 'Monthly plans for clinics, diagnostic centres and hospitals, from the live price list. Every self-serve plan starts with a free trial.', path: '/pricing', index: b.slug === PLATFORM_SLUG });
}

const limit = (n: number | null | undefined, unit: string) => (n == null ? `Unlimited ${unit}` : `${n.toLocaleString('en-IN')} ${unit}`);

/** Generated from MediCare's published plans (subscription-service): marketing never hard-codes prices. */
export default async function Pricing() {
  const plans = await publicPlans();
  const editions = [...new Set(plans.map((p) => p.edition))];
  return (
    <MarketingFrame path="/pricing" wide={false}>
      <PageHeader title="Plans and prices" subtitle="Per month, before GST (18%). Every self-serve plan starts with a free trial; no card needed to start." />
      {editions.map((ed) => (
        <section key={ed} aria-label={ed}>
          <h2 className="mc-section-title">{ed}</h2>
          <div className="mc-grid">
            {plans.filter((p) => p.edition === ed).map((p) => (
              <Card key={p.code} title={p.name}>
                <p className="mc-stat" style={{ fontSize: '1.6rem', marginTop: 0 }}>{inr(p.listPrice)}<span className="mc-meta"> / month</span></p>
                <ul style={{ paddingLeft: 18, margin: '0 0 12px' }}>
                  {p.modules.filter((m) => m.key !== 'core').map((m) => <li key={m.key}>{m.name}</li>)}
                  <li>{limit(p.features['core.branches']?.limit, 'branches')}</li>
                  {p.features['directory.doctors'] ? <li>{limit(p.features['directory.doctors']?.limit, 'doctors')}</li> : null}
                  {p.features['core.sms'] ? <li>{limit(p.features['core.sms']?.limit, 'SMS a month')}</li> : null}
                </ul>
                {p.trialDays > 0
                  ? <><Badge tone="success">{p.trialDays}-day free trial</Badge> <a className="mc-btn mc-btn-primary" href={`/signup?plan=${p.code}`} aria-label={`Start a free trial of ${p.name}`}>Start free trial</a></>
                  : <a className="mc-btn mc-btn-ghost" href="mailto:sales@medicare.example">Talk to sales</a>}
              </Card>
            ))}
          </div>
        </section>
      ))}
      <p className="mc-meta">Extra doctors, branches and SMS beyond a plan&apos;s allowance are priced on the subscription page once you are signed up.</p>
      <section aria-label="Questions">
        <h2 className="mc-section-title">Questions</h2>
        <JsonLd data={{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: PRICING_FAQ.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) }} />
        <div className="mc-faq">{PRICING_FAQ.map((x) => <details key={x.q}><summary>{x.q}</summary><p>{x.a}</p></details>)}</div>
      </section>
    </MarketingFrame>
  );
}
