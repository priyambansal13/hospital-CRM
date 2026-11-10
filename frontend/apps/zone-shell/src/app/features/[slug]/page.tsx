import { breadcrumbLd, describe, JsonLd, pageMeta, site } from '@mc/features/seo';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Icon } from '@mc/ui';
import { featureBySlug, SEGMENTS } from '@/lib/marketing';
import { MarketingFrame, marketingOnly } from '@/lib/marketing-frame';
import { inr, type PublicPlan, plansWith, publicPlans } from '@/lib/site';

export const dynamic = 'force-dynamic';
type P = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  await marketingOnly();
  const f = featureBySlug((await params).slug);
  if (!f) notFound();
  return pageMeta({ title: `${f.title} · MediCare`, description: describe(f.description), path: `/features/${f.slug}` });
}

/** One feature: the problem, how MediCare handles it, and which live plans include it. */
export default async function FeaturePage({ params }: P) {
  await marketingOnly();
  const f = featureBySlug((await params).slug);
  if (!f) notFound();
  const [s, plans] = await Promise.all([site(), publicPlans().catch(() => [] as PublicPlan[])]);
  const included = plansWith(plans, f.modules);
  const segments = SEGMENTS.filter((x) => f.segments.includes(x.slug));
  return (
    <MarketingFrame path={`/features/${f.slug}`}>
      <JsonLd data={breadcrumbLd(s, [{ name: 'MediCare', path: '/' }, { name: 'Features', path: '/features' }, { name: f.name, path: `/features/${f.slug}` }])} />
      <section className="mc-section" aria-label={f.name}>
        <nav className="mc-crumb" aria-label="Breadcrumb"><a href="/features">Features</a> / {f.name}</nav>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}><span className="mc-tile-icon"><Icon name={f.icon} /></span><h1 style={{ margin: 0 }}>{f.title}</h1></div>
        <p className="mc-lead" style={{ maxWidth: 760, margin: 0 }}>{f.description}</p>
        <div className="mc-feature" style={{ maxWidth: 760 }}><h2 style={{ margin: 0, fontSize: '1rem' }}>The problem</h2><p>{f.problem}</p></div>
        <div className="mc-prose"><h2>How MediCare handles it</h2><ul>{f.points.map((p) => <li key={p}>{p}</li>)}</ul></div>
        <div className="mc-prose">
          <h2>Which plans include it</h2>
          {included.length
            ? <ul>{included.map((p) => <li key={p.code}><a href={`/signup?plan=${p.code}`}>{p.name}</a>: {inr(p.listPrice)} a month{p.trialDays ? `, ${p.trialDays}-day free trial` : ''}</li>)}</ul>
            : <p>An add-on module: ask us to switch it on for your plan.</p>}
          <p><a href="/pricing">Compare all plans</a></p>
        </div>
        {segments.length ? <p className="mc-meta" style={{ margin: 0 }}>Used by: {segments.map((x, i) => <span key={x.slug}>{i ? ' · ' : ''}<a href={`/for/${x.slug}`}>{x.name}</a></span>)}</p> : null}
      </section>
      <div className="mc-band"><div className="mc-band-inner">
        <div><h2>See {f.name.toLowerCase()} on a real hospital</h2><p>A 20-minute demo on our sample hospital, or try it yourself free.</p></div>
        <div className="mc-actions"><a className="mc-btn mc-btn-ghost mc-btn-lg" href="/demo">Book a demo</a><a className="mc-btn mc-btn-ghost mc-btn-lg" href="/signup">Start a free trial</a></div>
      </div></div>
    </MarketingFrame>
  );
}
