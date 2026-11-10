import 'server-only';
import { cookies } from 'next/headers';

/** What the marketing site's cookies say about where this visitor came from (sent with a signup or a demo request). */
export async function attribution(): Promise<Record<string, unknown>> {
  const jar = await cookies();
  const consent = jar.get('mc_consent')?.value === 'ads';
  let tags: Record<string, unknown> = {};
  try { tags = JSON.parse(decodeURIComponent(jar.get('mc_attr')?.value ?? '')) as Record<string, unknown>; } catch { /* none */ }
  const keep = Object.fromEntries(Object.entries(tags).filter(([k, v]) => ['source', 'medium', 'campaign', 'term', 'content', 'landing', 'gclid', 'fbclid'].includes(k) && typeof v === 'string'));
  if (!consent) { delete keep.gclid; delete keep.fbclid; }
  return { ...keep, consent };
}
