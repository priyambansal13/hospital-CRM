'use client';
import { useEffect } from 'react';

/**
 * The hospital's own campaign links (Admin → Search and ads, docs/SEO-AND-ADS.md §4): a link with utm_source and
 * utm_campaign leaves a first-party cookie, "source / campaign", for 30 days, and an online booking made meanwhile
 * records it, so /admin/analytics shows bookings by link. Nothing else is stored and nothing is sent to anyone: no ad
 * pixels or third-party cookies ever run on a hospital's patient pages.
 */
export function CampaignCookie() {
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const tag = (k: string) => (q.get(k) ?? '').trim().toLowerCase().replace(/[^a-z0-9 ._+:-]/g, '').slice(0, 50);
    const source = tag('utm_source');
    if (!source) return;
    const value = `${source} / ${tag('utm_campaign') || 'none'}`;
    document.cookie = `mc_src=${encodeURIComponent(value)}; Max-Age=${30 * 86400}; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  }, []);
  return null;
}
