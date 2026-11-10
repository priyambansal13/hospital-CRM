import { branchLd, breadcrumbLd, describe, JsonLd, NO_INDEX, pageMeta, site } from '@mc/features/seo';
import { ZoneFrame } from '@mc/features';
import { origin } from '@mc/bff';
import { Card, PageHeader } from '@mc/ui';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import { DoctorCard } from '@/lib/doctor-card';
import { getPublicBranches, searchDoctors } from '@/lib/directory';
import { publicModules } from '@/lib/modules';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** By its current address, or one it had before a rename (the page then redirects). */
const load = cache(async (slug: string) => {
  const all = await getPublicBranches();
  return all.find((b) => b.slug === slug) ?? all.find((b) => b.oldSlugs?.includes(slug)) ?? null;
});
const place = (b: { area: string | null; city: string }) => (b.area && !b.area.toLowerCase().includes(b.city.toLowerCase()) ? `${b.area}, ${b.city}` : b.area ?? b.city);

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const b = await load(slug);
  if (!b) return NO_INDEX;
  const s = await site();
  return pageMeta({
    title: `${s.name}, ${b.name}${b.area ? ` (${place(b)})` : ''} · Doctors, lab tests and timings`,
    description: describe(`${s.name} at ${[b.address.line1, b.area ? place(b) : b.city].filter(Boolean).join(', ')}${b.address.pincode ? ` ${b.address.pincode}` : ''}.`, 'See the doctors and lab tests at this branch and book online.'),
    path: `/care/branches/${b.slug}`,
  });
}

/** One branch: where it is and who consults there (what "near me" searches land on). */
export default async function Branch({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const b = await load(slug);
  if (!b) notFound();
  // absolute: a path here would get the zone's basePath (/care) twice
  if (b.slug !== slug) permanentRedirect(`${await origin()}/care/branches/${b.slug}`);
  const [s, offered] = await Promise.all([site(), publicModules()]);
  const directory = offered.modules.includes('directory');
  const doctors = directory ? await searchDoctors(new URLSearchParams({ branch: b.id, limit: '50' })) : { items: [], nextCursor: null };
  const labOnly = !directory && offered.modules.includes('diagnostics');
  const address = [b.address.line1, b.area && !b.address.line1?.includes(b.area) ? b.area : null, b.city, b.address.pincode].filter(Boolean).join(', ');
  return (
    <ZoneFrame zone="patient" path="/care/doctors" zones={ZONES} requireAuth={false}>
      <JsonLd data={[branchLd(s, b, labOnly), breadcrumbLd(s, [{ name: s.name, path: '/' }, { name: b.name, path: `/care/branches/${b.slug}` }])]} />
      <PageHeader title={`${s.name}, ${b.name}`} subtitle={address} />
      <Card title="Visit us">
        <p style={{ marginTop: 0 }}>{address}</p>
        <p className="mc-meta" style={{ marginBottom: 0 }}>
          <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.name} ${address}`)}`} rel="noopener" target="_blank">Open in Maps</a>
          {offered.modules.includes('diagnostics') ? <> · <a href="/care/tests">Lab tests</a></> : null}
        </p>
      </Card>
      {directory ? (
        <>
          <h2 className="mc-section-title">Doctors at this branch</h2>
          {doctors.items.length ? doctors.items.map((d) => <DoctorCard key={d.id} d={d} />) : <Card><p className="mc-empty">No doctor is taking bookings at this branch right now.</p></Card>}
          {doctors.nextCursor ? <p><a href={`/care/doctors?branch=${b.id}`}>All doctors at {b.name} →</a></p> : null}
        </>
      ) : null}
    </ZoneFrame>
  );
}
