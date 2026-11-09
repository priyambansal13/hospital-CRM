import { site, specialtySlug, testSlug } from '@mc/features/seo';
import { PLATFORM_SLUG } from '@/lib/site';
import { publicBranches, publicCatalog, publicDoctorPaths, publicModules, publicSpecialties } from '@/lib/public-site';

export const dynamic = 'force-dynamic';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

/**
 * The public pages of the site this host serves, from live data: MediCare's own pages on the platform host; on a
 * hospital's host its home, branches, and (by plan) published doctors, specialties with doctors, tests and packages.
 * Never anything that needs sign-in. Empty for a hospital that isn't open; not found where no hospital answers.
 */
export async function GET() {
  const s = await site().catch(() => null);
  if (!s) return new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const paths: string[] = [];
  if (s.indexable) {
    if (s.branding.slug === PLATFORM_SLUG) paths.push('/', '/pricing', '/signup');
    else {
      const { modules } = await soft(publicModules(), { modules: [] as string[], readOnly: [] });
      const [branches, specialties, doctors, catalog] = await Promise.all([
        soft(publicBranches(), []),
        modules.includes('directory') ? soft(publicSpecialties(), []) : [],
        modules.includes('directory') ? soft(publicDoctorPaths(), []) : [],
        modules.includes('diagnostics') ? soft(publicCatalog(), { tests: [], packages: [] }) : { tests: [], packages: [] },
      ]);
      paths.push('/', ...branches.map((b) => `/care/branches/${b.slug}`));
      if (modules.includes('directory')) paths.push('/care/doctors', ...specialties.filter((x) => x.doctorCount > 0).map((x) => `/care/specialties/${specialtySlug(x.code)}`), ...doctors);
      if (modules.includes('diagnostics')) paths.push('/care/tests', ...catalog.packages.map((p) => `/care/packages/${testSlug(p.code)}`), ...catalog.tests.map((t) => `/care/tests/${testSlug(t.code)}`));
    }
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    [...new Set(paths)].map((p) => `  <url><loc>${xml(s.canonicalOrigin + p)}</loc></url>`).join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
