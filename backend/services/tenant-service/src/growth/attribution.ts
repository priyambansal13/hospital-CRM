import { z } from 'zod';

/** A UTM value: short, plain characters only (they are shown on the console and exported to ad platforms). */
const Tag = z.string().trim().max(100).regex(/^[\w .:/+-]*$/).transform((s) => s.toLowerCase()).optional().catch(undefined);
const ClickId = z.string().trim().max(300).regex(/^[\w.-]+$/).optional().catch(undefined);

/**
 * Where a visitor came from, as the marketing site's first-party cookie recorded it (docs/SEO-AND-ADS.md §3.5). Ad
 * click ids (gclid, fbclid) are only kept when the visitor accepted ad cookies; without consent they are dropped here
 * too, whatever the browser sent. A value that doesn't fit is dropped, never an error: a damaged cookie must not
 * stop a signup.
 */
export const Attribution = z.object({
  source: Tag, medium: Tag, campaign: Tag, term: Tag, content: Tag,
  gclid: ClickId, fbclid: ClickId,
  landing: z.string().trim().max(200).regex(/^\/[\w\-./]*$/).optional().catch(undefined),
  consent: z.boolean().default(false).catch(false),
}).default({ consent: false }).catch({ consent: false });
export type Attribution = z.infer<typeof Attribution>;

/** What is stored: the tags, the landing page, and click ids only with consent. */
export function stored(a: Attribution): { attribution: Record<string, string>; adsConsent: boolean } {
  const { consent, gclid, fbclid, ...rest } = a;
  const attribution = Object.fromEntries(Object.entries({ ...rest, ...(consent ? { gclid, fbclid } : {}) }).filter(([, v]) => v)) as Record<string, string>;
  return { attribution, adsConsent: consent };
}

/** How the funnel groups a row: "google / cpc / clinic-software", or "direct". */
export function channel(a: Record<string, string | undefined>): { source: string; medium: string; campaign: string } {
  if (!a.source && !a.medium && !a.campaign) return { source: a.gclid ? 'google' : a.fbclid ? 'meta' : 'direct', medium: a.gclid || a.fbclid ? 'cpc' : '(none)', campaign: '(none)' };
  return { source: a.source ?? '(none)', medium: a.medium ?? '(none)', campaign: a.campaign ?? '(none)' };
}
