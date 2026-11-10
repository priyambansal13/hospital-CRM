'use client';
import { useEffect, useState } from 'react';

/**
 * MediCare's marketing site only (docs/SEO-AND-ADS.md §3.5): remembers where a visitor came from in a first-party
 * cookie, asks for consent before any ad cookie, and loads the Google Ads and Meta tags only after "Accept". Never
 * rendered on a hospital's site or any signed-in page.
 *
 * mc_attr: UTM tags and the landing page (always), ad click ids (gclid, fbclid) only with consent. 30 days.
 * mc_consent: "ads" or "essential". 180 days.
 */
const ATTR = 'mc_attr';
const CONSENT = 'mc_consent';
const PENDING = 'mc_click_ids';
const TAGS = ['source', 'medium', 'campaign', 'term', 'content'] as const;

const readCookie = (k: string) => document.cookie.split('; ').find((c) => c.startsWith(`${k}=`))?.slice(k.length + 1) ?? null;
const writeCookie = (k: string, v: string, days: number) => {
  document.cookie = `${k}=${encodeURIComponent(v)}; Max-Age=${days * 86400}; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
};
const readAttr = (): Record<string, string> => { try { return JSON.parse(decodeURIComponent(readCookie(ATTR) ?? '')) as Record<string, string>; } catch { return {}; } };
const clean = (v: string | null, max = 100) => (v && /^[\w .:/+-]+$/.test(v) ? v.slice(0, max) : null);
const cleanId = (v: string | null) => (v && /^[\w.-]{1,300}$/.test(v) ? v : null);

declare global { interface Window { dataLayer?: unknown[]; gtag?: (...a: unknown[]) => void; fbq?: ((...a: unknown[]) => void) & { queue?: unknown[]; loaded?: boolean; version?: string; callMethod?: (...a: unknown[]) => void; push?: unknown } } }

function loadTags(googleId: string | null, metaId: string | null) {
  if (googleId && !window.gtag) {
    const s = document.createElement('script');
    s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(googleId)}`;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer ?? [];
    window.gtag = function gtag() { window.dataLayer!.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', googleId);
  }
  if (metaId && !window.fbq) {
    const q: unknown[] = [];
    const f = Object.assign((...a: unknown[]) => { if (f.callMethod) f.callMethod(...a); else q.push(a); }, { queue: q, loaded: true, version: '2.0' }) as NonNullable<Window['fbq']>;
    window.fbq = f;
    const s = document.createElement('script');
    s.async = true; s.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(s);
    f('init', metaId);
    f('track', 'PageView');
  }
}

export function Tracking({ googleId, metaId }: { googleId: string | null; metaId: string | null }) {
  const [ask, setAsk] = useState(false);

  useEffect(() => {
    const url = new URL(location.href);
    const tags = Object.fromEntries(TAGS.map((t) => [t, clean(url.searchParams.get(`utm_${t}`))]).filter(([, v]) => v)) as Record<string, string>;
    const ids = Object.fromEntries((['gclid', 'fbclid'] as const).map((k) => [k, cleanId(url.searchParams.get(k))]).filter(([, v]) => v)) as Record<string, string>;
    const consent = readCookie(CONSENT);
    // a new campaign visit replaces the last one (last campaign touch); a plain visit keeps it
    if (Object.keys(tags).length || Object.keys(ids).length) {
      const landing = clean(url.pathname, 200) ?? '/';
      writeCookie(ATTR, JSON.stringify({ ...tags, landing, ...(consent === 'ads' ? ids : {}) }), 30);
      if (consent !== 'ads' && Object.keys(ids).length) sessionStorage.setItem(PENDING, JSON.stringify(ids));
    }
    if (consent === 'ads') loadTags(googleId, metaId);
    else if (!consent) setAsk(true);
    const reopen = () => setAsk(true);
    window.addEventListener('mc:cookie-settings', reopen);
    return () => window.removeEventListener('mc:cookie-settings', reopen);
  }, [googleId, metaId]);

  const decide = (choice: 'ads' | 'essential') => {
    writeCookie(CONSENT, choice, 180);
    const attr = readAttr();
    if (choice === 'ads') {
      // click ids seen before the visitor said yes
      try { Object.assign(attr, JSON.parse(sessionStorage.getItem(PENDING) ?? '{}')); } catch { /* none */ }
      if (Object.keys(attr).length) writeCookie(ATTR, JSON.stringify(attr), 30);
      loadTags(googleId, metaId);
    } else if (attr.gclid || attr.fbclid) {
      delete attr.gclid; delete attr.fbclid;
      writeCookie(ATTR, JSON.stringify(attr), 30);
    }
    sessionStorage.removeItem(PENDING);
    setAsk(false);
  };

  if (!ask) return null;
  return (
    <div className="mc-consent" role="dialog" aria-label="Cookies">
      <strong>Cookies on MediCare&apos;s site</strong>
      <p>We use a cookie to remember which campaign brought you here. With your OK we also use Google and Meta advertising cookies to measure our ads. This is MediCare&apos;s own site: hospitals&apos; patient pages never have ad cookies.</p>
      <div className="mc-actions">
        <button type="button" className="mc-btn mc-btn-ghost" onClick={() => decide('essential')}>Only necessary</button>
        <button type="button" className="mc-btn mc-btn-primary" onClick={() => decide('ads')}>Accept ad cookies</button>
      </div>
    </div>
  );
}

/** "Cookie settings" in the footer: asks again. */
export function CookieSettings() {
  return <button type="button" onClick={() => window.dispatchEvent(new Event('mc:cookie-settings'))}>Cookie settings</button>;
}
