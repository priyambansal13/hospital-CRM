import 'server-only';
import type { Metadata } from 'next';
import { cache } from 'react';
import { type Branding, getBranding, origin } from '@mc/bff';

/**
 * Search-engine basics for public pages (docs/SEO-AND-ADS.md §2): titles and descriptions from live data, one canonical
 * address per page, Open Graph cards for sharing, schema.org structured data, and "keep out" for everything else.
 * Every zone's layout says noindex; public pages opt in with pageMeta(). Only an open hospital is indexed (READ_ONLY
 * lasts seconds, during a move); one taken offline doesn't serve pages at all, and its robots.txt says keep out.
 */
export interface Site {
  name: string;
  /** where this request came from, e.g. http://aarogya.localhost:3400 */
  origin: string;
  /** where pages say they live: the hospital's primary host (custom domain first), same scheme and port */
  canonicalOrigin: string;
  indexable: boolean;
  logo: string | null;
  branding: Branding;
}

export const site = cache(async (): Promise<Site> => {
  const [b, here] = await Promise.all([getBranding(), origin()]);
  const url = new URL(here);
  const canonicalOrigin = b.primaryHost ? `${url.protocol}//${b.primaryHost}${url.port ? `:${url.port}` : ''}` : here;
  return { name: b.name, origin: here, canonicalOrigin, indexable: ['ACTIVE', 'READ_ONLY'].includes(b.status ?? 'ACTIVE'), logo: b.branding.logoUrl ?? null, branding: b };
});

/** For layouts and private pages. */
export const NO_INDEX: Metadata = { robots: { index: false, follow: false } };

/** Metadata for a public page; `index: false` keeps a page (e.g. a filtered list) out while its links are still followed. */
export async function pageMeta(p: { title: string; description: string; path: string; index?: boolean; image?: string | null }): Promise<Metadata> {
  const s = await site();
  const url = s.canonicalOrigin + p.path;
  // a page's own image (a doctor's photo), else the hospital's generated sharing card (/og.png, zone-shell)
  const image = p.image ?? `${s.canonicalOrigin}/og.png`;
  const index = (p.index ?? true) && s.indexable;
  return {
    title: { absolute: p.title },
    description: p.description,
    alternates: { canonical: url },
    robots: index ? { index: true, follow: true } : { index: false, follow: s.indexable },
    openGraph: { title: p.title, description: p.description, url, siteName: s.name, type: 'website', locale: 'en_IN', images: [p.image ? { url: image } : { url: image, width: 1200, height: 630, alt: s.name }] },
    twitter: { card: p.image ? 'summary' : 'summary_large_image', title: p.title, description: p.description, images: [image] },
  };
}

/** Descriptions: one line, no more than search engines show. */
export function describe(...parts: (string | null | undefined | false)[]): string {
  const s = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return s.length <= 158 ? s : `${s.slice(0, 155).replace(/\s+\S*$/, '')}…`;
}

/** schema.org JSON-LD; `<` is escaped so data can never close the script tag. */
export function JsonLd({ data }: { data: object | object[] }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />;
}

// ---------- structured data ----------

export interface LdBranch { slug: string; name: string; city: string; area?: string | null; address: { line1: string | null; pincode: string | null } }

const postal = (b: LdBranch) => ({
  '@type': 'PostalAddress', ...(b.address.line1 ? { streetAddress: b.address.line1 } : {}), addressLocality: b.city,
  ...(b.address.pincode ? { postalCode: b.address.pincode } : {}), addressCountry: 'IN',
});

/** The hospital and its branches. A lab-only hospital's branches are DiagnosticLab, others MedicalClinic. */
export function organizationLd(s: Site, branches: LdBranch[], labOnly = false) {
  const home = `${s.canonicalOrigin}/`;
  return {
    '@context': 'https://schema.org', '@type': 'MedicalOrganization', '@id': `${home}#org`, name: s.name, url: home,
    ...(s.logo ? { logo: s.logo } : {}), ...(s.branding.branding.description ? { description: s.branding.branding.description } : {}),
    subOrganization: branches.map((b) => branchLd(s, b, labOnly, false)),
  };
}

export function branchLd(s: Site, b: LdBranch, labOnly = false, withContext = true) {
  return {
    ...(withContext ? { '@context': 'https://schema.org' } : {}),
    '@type': labOnly ? 'DiagnosticLab' : 'MedicalClinic', name: `${s.name}, ${b.name}`, url: `${s.canonicalOrigin}/care/branches/${b.slug}`,
    address: postal(b), ...(b.area ? { areaServed: b.area } : {}), parentOrganization: { '@id': `${s.canonicalOrigin}/#org` },
  };
}

export function physicianLd(s: Site, d: { name: string; image?: string | null; path: string; specialties: string[]; languages: string[]; qualifications: string[]; branches: string[] }) {
  const url = s.canonicalOrigin + d.path;
  return {
    '@context': 'https://schema.org', '@type': 'Physician', name: d.name, url, ...(d.image ? { image: d.image } : {}),
    ...(d.specialties.length ? { medicalSpecialty: d.specialties } : {}),
    ...(d.languages.length ? { knowsLanguage: d.languages } : {}),
    ...(d.qualifications.length ? { hasCredential: d.qualifications.map((q) => ({ '@type': 'EducationalOccupationalCredential', name: q })) } : {}),
    ...(d.branches.length ? { hospitalAffiliation: d.branches.map((b) => ({ '@type': 'MedicalClinic', name: `${s.name}, ${b}` })) } : {}),
    memberOf: { '@id': `${s.canonicalOrigin}/#org` },
    potentialAction: { '@type': 'ReserveAction', target: `${url}#book`, name: 'Book an appointment' },
  };
}

/** A lab test or package, offered at a price by the hospital. */
export function testLd(s: Site, t: { name: string; path: string; price: number; category?: string | null; description?: string | null }) {
  return {
    '@context': 'https://schema.org', '@type': 'Service', serviceType: 'Laboratory test', name: t.name, url: s.canonicalOrigin + t.path,
    ...(t.category ? { category: t.category } : {}), ...(t.description ? { description: t.description } : {}),
    provider: { '@id': `${s.canonicalOrigin}/#org`, '@type': 'MedicalOrganization', name: s.name },
    offers: { '@type': 'Offer', price: t.price.toFixed(2), priceCurrency: 'INR', availability: 'https://schema.org/InStock' },
  };
}

export function breadcrumbLd(s: Site, items: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: s.canonicalOrigin + it.path })),
  };
}

// ---------- addresses ----------

/** Specialty codes are unique per hospital: "OBSTETRICS_GYNECOLOGY" ↔ "obstetrics-gynecology". */
export const specialtySlug = (code: string) => code.toLowerCase().replace(/_/g, '-');
export const specialtyCode = (slug: string) => (/^[a-z][a-z0-9-]{1,39}$/.test(slug) ? slug.toUpperCase().replace(/-/g, '_') : null);
/** Lab test and package codes, the same way ("HBA1C" ↔ "hba1c"). */
export const testSlug = specialtySlug;
export const testCode = (slug: string) => (/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug) ? slug.toUpperCase().replace(/-/g, '_') : null);
/** A doctor's page: the readable address when there is one (search results built before it existed have only the id). */
export const doctorPath = (d: { id: string; slug?: string | null }) => `/care/doctors/${d.slug ?? d.id}`;
