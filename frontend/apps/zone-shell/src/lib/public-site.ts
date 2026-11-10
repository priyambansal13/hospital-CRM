import 'server-only';
import { api } from '@mc/bff';

/** What a hospital's public site is built from (no sign-in; the hospital comes from the host). */
export interface PublicBranch { id: string; slug: string; name: string; city: string; area?: string | null; address: { line1: string | null; pincode: string | null }; timezone: string }
export const publicBranches = () => api<PublicBranch[]>('/api/tenant/v1/public/branches');
export const publicModules = () => api<{ modules: string[]; readOnly: string[] }>('/api/entitlement/v1/public/modules');
export interface PublicSpecialty { code: string; name: string; doctorCount: number }
export const publicSpecialties = () => api<PublicSpecialty[]>('/api/provider/v1/public/specialties');
export interface LabCatalog { tests: { code: string }[]; packages: { code: string }[] }
export const publicCatalog = () => api<LabCatalog>('/api/diagnostics/v1/public/lab-catalog');

/** Every published doctor's page (the directory, page by page: the sitemap must not miss anyone search hasn't indexed). */
export async function publicDoctorPaths(): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const r: { items: { id: string; slug?: string | null }[]; nextCursor: string | null } =
      await api(`/api/provider/v1/public/doctors?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...r.items.map((d) => `/care/doctors/${d.slug ?? d.id}`));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}
