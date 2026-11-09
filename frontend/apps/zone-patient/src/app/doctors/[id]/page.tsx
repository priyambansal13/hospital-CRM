import { ApiError, origin } from '@mc/bff';
import { breadcrumbLd, JsonLd, NO_INDEX, pageMeta, describe, physicianLd, site, specialtySlug } from '@mc/features/seo';
import type { Metadata } from 'next';
import { cache } from 'react';
import { ZoneFrame } from '@mc/features';
import { Button, Card, Field, Table } from '@mc/ui';
import { notFound, permanentRedirect } from 'next/navigation';
import { publicSlots } from '@/lib/booking';
import { joinWaitlist } from '@/lib/booking-actions';
import { getDoctor, initials, languageName } from '@/lib/directory';
import { Flash } from '@/lib/flash';
import { SlotPicker } from '@/lib/slot-picker';
import { BookingPaused } from '@/lib/booking-paused';
import { publicModules } from '@/lib/modules';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** By web address or id; the page and its metadata share one call per request. Unknown or unpublished: not found. */
const load = cache((idOrSlug: string) => getDoctor(idOrSlug).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e))));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  // the module off, or no such doctor: the page itself answers (paused notice / not found)
  const d = await load((await params).id).catch(() => null);
  if (!d) return NO_INDEX;
  const s = await site();
  const specialty = (d.specialties.find((x) => x.primary) ?? d.specialties[0])?.name;
  const where = [...new Set(d.branches.map((b) => b.name).filter(Boolean))].join(', ');
  const fees = d.branches.map((b) => b.fee);
  return pageMeta({
    title: `${d.name}${specialty ? `, ${specialty}` : ''} · ${s.name} · Book appointment`,
    description: describe(`Book an appointment with ${d.name}${specialty ? `, ${specialty.toLowerCase()}` : ''} at ${s.name}${where ? ` (${where})` : ''}.`,
      d.experienceYears != null ? `${d.experienceYears} years of experience.` : null, d.qualifications.length ? `${d.qualifications.join(', ')}.` : null,
      fees.length ? `Consultation from ₹${Math.min(...fees)}.` : null, 'See free times and book online.'),
    path: `/care/doctors/${d.slug ?? d.id}`,
    image: d.photoUrl,
  });
}

export default async function DoctorProfile({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string; ok?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const offered = await publicModules();
  if (!offered.modules.includes('directory')) {
    return <ZoneFrame zone="patient" path="/care/doctors" zones={ZONES} requireAuth={false}><BookingPaused /></ZoneFrame>;
  }
  const booking = offered.modules.includes('appointments');
  const d = await load(id);
  const here = d.slug ?? d.id;
  if (id !== here) {
    // an id link or an address the doctor had before: the one current address, keeping ?date / ?ok / ?error
    const qs = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === 'string')).toString();
    permanentRedirect(`${await origin()}/care/doctors/${here}${qs ? `?${qs}` : ''}`);
  }
  const s = await site();
  const slots = !booking ? { doctor: { id: d.id, name: '' }, days: [] } : await publicSlots(d.id).catch(() => ({ doctor: { id: d.id, name: d.name }, days: [] }));
  const primary = d.specialties.find((x) => x.primary) ?? d.specialties[0];
  return (
    <ZoneFrame zone="patient" path="/care/doctors" zones={ZONES} requireAuth={false}>
      <JsonLd data={[
        physicianLd(s, { name: d.name, path: `/care/doctors/${here}`, specialties: d.specialties.map((x) => x.name), languages: d.languages.map(languageName), qualifications: d.qualifications, branches: d.branches.map((b) => b.name ?? '').filter(Boolean) }),
        breadcrumbLd(s, [{ name: s.name, path: '/' }, { name: 'Doctors', path: '/care/doctors' }, ...(primary ? [{ name: primary.name, path: `/care/specialties/${specialtySlug(primary.code)}` }] : []), { name: d.name, path: `/care/doctors/${here}` }]),
      ]} />
      <div className="mc-card mc-doctor">
        <div className="mc-avatar" aria-hidden>{initials(d.name)}</div>
        <div>
          <h1 style={{ fontSize: '1.4rem' }}>{d.name}</h1>
          <p className="mc-meta">{d.specialties.map((x, i) => <span key={x.code}>{i ? ', ' : ''}<a href={`/care/specialties/${specialtySlug(x.code)}`}>{x.name}</a></span>)}</p>
          <p className="mc-meta">{[d.qualifications.join(', '), d.experienceYears != null ? `${d.experienceYears} years of experience` : null].filter(Boolean).join(' · ')}</p>
          {d.languages.length ? <p className="mc-meta">Speaks {d.languages.map(languageName).join(', ')}</p> : null}
        </div>
        <div />
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      {!booking ? <BookingPaused /> : <Card title="Book an appointment">
        <div id="book" />
        <SlotPicker data={slots} selected={sp.date} dateHref={(date) => `/care/doctors/${here}?date=${date}#book`} slotHref={(slotId) => `/care/book/${slotId}`} />
        <form action={joinWaitlist} className="mc-form" style={{ marginTop: 20 }}>
          <input type="hidden" name="doctorId" value={d.id} />
          <Field label="No time that suits you? Join the waitlist for" name="date" type="date" required />
          <Button variant="ghost">Join waitlist</Button>
        </form>
      </Card>}
      {d.bio ? <Card title="About"><p style={{ margin: 0, whiteSpace: 'pre-line' }}>{d.bio}</p></Card> : null}
      <Card title="Where to consult">
        <Table
          rows={d.branches}
          empty="No branches listed."
          columns={[
            { header: 'Branch', cell: (b) => b.name ?? '—' },
            { header: 'Consultation fee', cell: (b) => `₹${b.fee}` },
            { header: 'Modes', cell: () => d.consultModes.map((m) => (m === 'VIDEO' ? 'Video' : 'In person')).join(', ') },
          ]}
        />
      </Card>
      <p><a href="/care/doctors">← All doctors</a></p>
    </ZoneFrame>
  );
}
