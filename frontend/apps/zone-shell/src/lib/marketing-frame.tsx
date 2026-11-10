import { ZoneFrame } from '@mc/features';
import { getBranding } from '@mc/bff';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ARTICLES, FEATURES, SEGMENTS } from './marketing';
import { PLATFORM_SLUG } from './site';
import { CookieSettings, Tracking } from './tracking';
import { ZONES } from './zones';

/** The marketing pages exist on MediCare's own host only; a hospital's host answers 404. */
export async function marketingOnly() {
  if ((await getBranding()).slug !== PLATFORM_SLUG) notFound();
}

/**
 * MediCare's marketing pages: the usual frame, link columns (crawlable internal links to every page), and the
 * consent banner with campaign attribution. Ad tag ids come from the server's environment and are only used here.
 */
export async function MarketingFrame({ path, wide = true, children }: { path: string; wide?: boolean; children: ReactNode }) {
  // pricing and signup also answer on a hospital's host: there, no marketing links and never any tracking
  if ((await getBranding()).slug !== PLATFORM_SLUG) return <ZoneFrame zone="shell" path={path} zones={ZONES} requireAuth={false} wide={wide}>{children}</ZoneFrame>;
  return (
    <ZoneFrame zone="shell" path={path} zones={ZONES} requireAuth={false} wide={wide}>
      {children}
      <nav className="mc-mkt-links" aria-label="MediCare site">
        <div><h3>Product</h3><ul>{FEATURES.map((f) => <li key={f.slug}><a href={`/features/${f.slug}`}>{f.name}</a></li>)}</ul></div>
        <div><h3>Who it is for</h3><ul>{SEGMENTS.map((s) => <li key={s.slug}><a href={`/for/${s.slug}`}>{s.name}</a></li>)}</ul></div>
        <div><h3>Guides</h3><ul>{ARTICLES.map((a) => <li key={a.slug}><a href={`/resources/${a.slug}`}>{a.title.split(':')[0]}</a></li>)}<li><a href="/resources">All guides</a></li></ul></div>
        <div><h3>MediCare</h3><ul>
          <li><a href="/pricing">Plans and prices</a></li><li><a href="/security">Security and privacy</a></li><li><a href="/status">System status</a></li>
          <li><a href="/demo">Book a demo</a></li><li><a href="/signup">Start a free trial</a></li><li><CookieSettings /></li>
        </ul></div>
      </nav>
      <Tracking googleId={process.env.GOOGLE_ADS_TAG_ID || null} metaId={process.env.META_PIXEL_ID || null} />
    </ZoneFrame>
  );
}
