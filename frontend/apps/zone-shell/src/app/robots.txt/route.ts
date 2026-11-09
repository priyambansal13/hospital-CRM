import { site } from '@mc/features/seo';
import { PLATFORM_SLUG } from '@/lib/site';

export const dynamic = 'force-dynamic';

/**
 * Per host. A hospital: only its public pages (home, branches, doctors, specialties, tests, packages) may be crawled;
 * patients' own pages, report checks, sign-in, every staff zone and the API may not. MediCare's own host: the marketing
 * pages only. A hospital that isn't open, or no hospital at this address: nothing. Pages also carry their own noindex, so this is the second fence.
 */
export async function GET() {
  const s = await site().catch(() => null);
  // no hospital at this address (unknown, offline, deleted): keep out
  if (!s) return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } });
  const lines = ['User-agent: *'];
  if (!s.indexable) lines.push('Disallow: /');
  else if (s.branding.slug === PLATFORM_SLUG) {
    lines.push('Allow: /$', 'Allow: /pricing', 'Allow: /signup$', 'Disallow: /');
  } else {
    lines.push(
      'Allow: /$',
      'Allow: /care/doctors', 'Allow: /care/specialties/', 'Allow: /care/branches/', 'Allow: /care/tests', 'Allow: /care/packages/',
      'Disallow: /care/tests/book',
      'Disallow: /',
    );
  }
  lines.push('', `Sitemap: ${s.canonicalOrigin}/sitemap.xml`, '');
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
