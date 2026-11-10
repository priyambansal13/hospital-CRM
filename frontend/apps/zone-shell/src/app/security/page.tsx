import { breadcrumbLd, JsonLd, pageMeta, site } from '@mc/features/seo';
import type { Metadata } from 'next';
import { Icon } from '@mc/ui';
import { SECURITY } from '@/lib/marketing';
import { MarketingFrame, marketingOnly } from '@/lib/marketing-frame';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  await marketingOnly();
  return pageMeta({ title: 'Security and patient privacy · MediCare', description: "A database per hospital, field encryption, a record-access log patients can see, role and branch access, backups, and no ad tracking on patients' pages.", path: '/security' });
}

export default async function Security() {
  await marketingOnly();
  const s = await site();
  return (
    <MarketingFrame path="/security">
      <JsonLd data={breadcrumbLd(s, [{ name: 'MediCare', path: '/' }, { name: 'Security', path: '/security' }])} />
      <section className="mc-section" aria-label="Security">
        <span className="mc-kicker">Security and privacy</span>
        <h1 style={{ margin: 0 }}>Your patients&apos; records stay yours</h1>
        <p className="mc-lead" style={{ maxWidth: 760, margin: 0 }}>How MediCare keeps each hospital&apos;s data apart, who can see a record, and what happens to the data if you leave.</p>
        <div className="mc-features">
          {SECURITY.map((x) => <div key={x.title} className="mc-feature"><span className="mc-tile-icon"><Icon name="shield" /></span><h2 style={{ margin: 0, fontSize: '1rem' }}>{x.title}</h2><p>{x.text}</p></div>)}
        </div>
        <p className="mc-meta" style={{ margin: 0 }}>Need the details for your IT or legal review? <a href="/demo">Ask for a security walk-through</a>.</p>
      </section>
    </MarketingFrame>
  );
}
