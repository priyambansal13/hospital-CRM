import { breadcrumbLd, JsonLd, pageMeta, site } from '@mc/features/seo';
import type { Metadata } from 'next';
import { Icon } from '@mc/ui';
import { FEATURES } from '@/lib/marketing';
import { MarketingFrame, marketingOnly } from '@/lib/marketing-frame';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  await marketingOnly();
  return pageMeta({ title: 'Features · MediCare hospital and clinic software', description: 'Online booking, front desk and queue, medical records and prescriptions, lab and home collection, billing, AI assistance and analytics, in one subscription.', path: '/features' });
}

export default async function Features() {
  await marketingOnly();
  const s = await site();
  return (
    <MarketingFrame path="/features">
      <JsonLd data={breadcrumbLd(s, [{ name: 'MediCare', path: '/' }, { name: 'Features', path: '/features' }])} />
      <section className="mc-section" aria-label="Features">
        <div className="mc-section-head"><div><span className="mc-kicker">Features</span><h1 style={{ margin: '6px 0 0' }}>Everything a hospital runs on, in one place</h1></div></div>
        <p className="mc-muted" style={{ maxWidth: 720, margin: 0 }}>Pick the plan for your type of practice; each page says which plans include the feature.</p>
        <div className="mc-features">
          {FEATURES.map((f) => (
            <a key={f.slug} className="mc-feature" href={`/features/${f.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="mc-tile-icon"><Icon name={f.icon} /></span>
              <h2 style={{ margin: 0, fontSize: '1rem' }}>{f.name}</h2>
              <p>{f.description}</p>
            </a>
          ))}
        </div>
      </section>
    </MarketingFrame>
  );
}
