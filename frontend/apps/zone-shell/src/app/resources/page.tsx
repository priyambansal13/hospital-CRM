import { breadcrumbLd, JsonLd, pageMeta, site } from '@mc/features/seo';
import type { Metadata } from 'next';
import { ARTICLES } from '@/lib/marketing';
import { MarketingFrame, marketingOnly } from '@/lib/marketing-frame';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  await marketingOnly();
  return pageMeta({ title: 'Guides for clinic and hospital owners · MediCare', description: 'Practical guides on no-shows, online booking and moving from paper to software, written for Indian clinics and hospitals.', path: '/resources' });
}

export default async function Resources() {
  await marketingOnly();
  const s = await site();
  return (
    <MarketingFrame path="/resources">
      <JsonLd data={breadcrumbLd(s, [{ name: 'MediCare', path: '/' }, { name: 'Guides', path: '/resources' }])} />
      <section className="mc-section" aria-label="Guides">
        <span className="mc-kicker">Guides</span>
        <h1 style={{ margin: 0 }}>Guides for clinic and hospital owners</h1>
        <div className="mc-features">
          {ARTICLES.map((a) => (
            <a key={a.slug} className="mc-feature" href={`/resources/${a.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <h2 style={{ margin: 0, fontSize: '1rem' }}>{a.title}</h2><p>{a.description}</p>
            </a>
          ))}
        </div>
      </section>
    </MarketingFrame>
  );
}
