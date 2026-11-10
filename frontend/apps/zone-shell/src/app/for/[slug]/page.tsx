import { breadcrumbLd, describe, JsonLd, pageMeta, site } from '@mc/features/seo';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Icon } from '@mc/ui';
import { FEATURES, segmentBySlug } from '@/lib/marketing';
import { MarketingFrame, marketingOnly } from '@/lib/marketing-frame';
import { distinctPlans, inr, type PublicPlan, publicPlans } from '@/lib/site';

export const dynamic = 'force-dynamic';
type P = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  await marketingOnly();
  const g = segmentBySlug((await params).slug);
  if (!g) notFound();
  return pageMeta({ title: g.title, description: describe(g.description), path: `/for/${g.slug}` });
}

/** One kind of buyer, in their own words: their problems, what answers them, the plans that fit. */
export default async function SegmentPage({ params }: P) {
  await marketingOnly();
  const g = segmentBySlug((await params).slug);
  if (!g) notFound();
  const [s, plans] = await Promise.all([site(), publicPlans().catch(() => [] as PublicPlan[])]);
  const fit = distinctPlans(plans.filter((p) => p.edition === g.edition));
  const features = g.features.map((k) => FEATURES.find((f) => f.slug === k)!).filter(Boolean);
  return (
    <MarketingFrame path={`/for/${g.slug}`}>
      <JsonLd data={breadcrumbLd(s, [{ name: 'MediCare', path: '/' }, { name: g.name, path: `/for/${g.slug}` }])} />
      <section className="mc-section" aria-label={g.name}>
        <span className="mc-kicker">{g.headline}</span>
        <h1 style={{ margin: 0 }}>{g.title.replace(/ · MediCare$/, '')}</h1>
        <p className="mc-lead" style={{ maxWidth: 760, margin: 0 }}>{g.intro}</p>
        <div className="mc-features">
          {g.pains.map((x) => <div key={x.pain} className="mc-feature"><h2 style={{ margin: 0, fontSize: '1rem' }}>{x.pain}</h2><p>{x.answer}</p></div>)}
        </div>
      </section>
      <section className="mc-section" aria-label="What you get">
        <div className="mc-section-head"><div><span className="mc-kicker">What you get</span><h2>The parts that matter to you</h2></div></div>
        <div className="mc-tiles">
          {features.map((f) => <a key={f.slug} className="mc-tile" href={`/features/${f.slug}`}><span className="mc-tile-icon"><Icon name={f.icon} /></span><strong>{f.name}</strong><span>{f.description}</span></a>)}
        </div>
      </section>
      {fit.length ? (
        <section className="mc-section" aria-label="Plans">
          <div className="mc-section-head"><div><span className="mc-kicker">Plans</span><h2>Plans for {g.name.toLowerCase()}</h2></div><a className="mc-btn mc-btn-ghost" href="/pricing">All plans</a></div>
          <div className="mc-plans">
            {fit.map((p) => (
              <div key={p.code} className="mc-plan">
                <h3 style={{ margin: 0 }}>{p.name}</h3>
                <div className="mc-price">{inr(p.listPrice)}<span className="mc-meta" style={{ fontSize: 14, fontWeight: 600 }}> / month</span></div>
                <span className="mc-meta">{p.trialDays ? `${p.trialDays}-day free trial` : 'Talk to us'}</span>
                <ul>{p.modules.filter((m) => m.key !== 'core').map((m) => <li key={m.key}>{m.name}</li>)}</ul>
                {p.trialDays ? <a className="mc-btn mc-btn-primary" href={`/signup?plan=${p.code}`}>Start with {p.name}</a> : <a className="mc-btn mc-btn-ghost" href="/demo">Book a demo</a>}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <div className="mc-band"><div className="mc-band-inner">
        <div><h2>See it on a hospital like yours</h2><p>A 20-minute walk-through with our sample hospital.</p></div>
        <div className="mc-actions"><a className="mc-btn mc-btn-ghost mc-btn-lg" href={`/demo?segment=${g.slug}`}>Book a demo</a><a className="mc-btn mc-btn-ghost mc-btn-lg" href="/signup">Start a free trial</a></div>
      </div></div>
    </MarketingFrame>
  );
}
