import { breadcrumbLd, describe, JsonLd, NO_INDEX, pageMeta, site, specialtyCode } from '@mc/features/seo';
import { ZoneFrame } from '@mc/features';
import { Card, PageHeader } from '@mc/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { DoctorCard } from '@/lib/doctor-card';
import { getSpecialties, searchDoctors } from '@/lib/directory';
import { publicModules } from '@/lib/modules';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** A specialty with published doctors, by its web address ("cardiology"); anything else is not found. */
const load = cache(async (slug: string) => {
  const code = specialtyCode(slug);
  if (!code || !(await publicModules()).modules.includes('directory')) return null;
  return (await getSpecialties()).find((s) => s.code === code && s.doctorCount > 0) ?? null;
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const sp = await load(slug);
  if (!sp) return NO_INDEX;
  const s = await site();
  return pageMeta({
    title: `${sp.name} doctors at ${s.name} · Book online`,
    description: describe(`${sp.doctorCount} ${sp.name.toLowerCase()} doctor${sp.doctorCount === 1 ? '' : 's'} at ${s.name}.`, sp.description, 'Compare experience and fees, see the next free time and book online.'),
    path: `/care/specialties/${slug}`,
  });
}

/** Landing page for a specialty: what search engines send "cardiologist in <city>" to. */
export default async function Specialty({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const sp = await load(slug);
  if (!sp) notFound();
  const [s, found] = await Promise.all([site(), searchDoctors(new URLSearchParams({ specialty: sp.code, limit: '50' }))]);
  return (
    <ZoneFrame zone="patient" path="/care/doctors" zones={ZONES} requireAuth={false}>
      <JsonLd data={breadcrumbLd(s, [{ name: s.name, path: '/' }, { name: 'Doctors', path: '/care/doctors' }, { name: sp.name, path: `/care/specialties/${slug}` }])} />
      <PageHeader title={`${sp.name} doctors`} subtitle={sp.description ?? `Choose a doctor at ${s.name} to see their profile, fees and free times.`} />
      {found.items.length ? found.items.map((d) => <DoctorCard key={d.id} d={d} />) : <Card><p className="mc-empty">No doctor is taking bookings in {sp.name} right now.</p></Card>}
      {found.nextCursor ? <p><a href={`/care/doctors?specialty=${sp.code}`}>All {sp.name.toLowerCase()} doctors →</a></p> : null}
      <p><a href="/care/doctors">← All doctors</a></p>
    </ZoneFrame>
  );
}
