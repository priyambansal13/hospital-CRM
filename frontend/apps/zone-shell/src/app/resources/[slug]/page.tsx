import { breadcrumbLd, describe, JsonLd, pageMeta, site } from '@mc/features/seo';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { articleBySlug, featureBySlug } from '@/lib/marketing';
import { MarketingFrame, marketingOnly } from '@/lib/marketing-frame';

export const dynamic = 'force-dynamic';
type P = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  await marketingOnly();
  const a = articleBySlug((await params).slug);
  if (!a) notFound();
  const m = await pageMeta({ title: `${a.title} · MediCare`, description: describe(a.description), path: `/resources/${a.slug}` });
  return { ...m, openGraph: { ...m.openGraph, type: 'article', publishedTime: a.published } };
}

export default async function ArticlePage({ params }: P) {
  await marketingOnly();
  const a = articleBySlug((await params).slug);
  if (!a) notFound();
  const s = await site();
  const f = featureBySlug(a.feature);
  const url = `${s.canonicalOrigin}/resources/${a.slug}`;
  return (
    <MarketingFrame path={`/resources/${a.slug}`}>
      <JsonLd data={[
        { '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: a.description, datePublished: a.published, url, mainEntityOfPage: url, author: { '@type': 'Organization', name: 'MediCare' }, publisher: { '@id': `${s.canonicalOrigin}/#org`, '@type': 'Organization', name: 'MediCare' } },
        breadcrumbLd(s, [{ name: 'MediCare', path: '/' }, { name: 'Guides', path: '/resources' }, { name: a.title, path: `/resources/${a.slug}` }]),
      ]} />
      <article className="mc-section mc-prose" aria-label={a.title}>
        <nav className="mc-crumb" aria-label="Breadcrumb"><a href="/resources">Guides</a></nav>
        <h1 style={{ margin: 0 }}>{a.title}</h1>
        <p className="mc-meta" style={{ margin: 0 }}>MediCare · <time dateTime={a.published}>{new Date(a.published).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</time></p>
        <div>
          {a.body.map((b, i) => (
            <div key={i}>
              {b.h ? <h2>{b.h}</h2> : null}
              {b.p ? <p>{b.p}</p> : null}
              {b.list ? <ul>{b.list.map((x) => <li key={x}>{x}</li>)}</ul> : null}
            </div>
          ))}
        </div>
        {f ? <p><strong>On MediCare:</strong> <a href={`/features/${f.slug}`}>{f.name}</a> does this for you. <a href="/signup">Try it free</a>.</p> : null}
      </article>
    </MarketingFrame>
  );
}
