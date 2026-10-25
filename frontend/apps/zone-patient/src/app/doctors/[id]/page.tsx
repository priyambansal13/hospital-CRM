import { ApiError } from '@mc/bff';
import { ZoneFrame } from '@mc/features';
import { Button, Card, Field, Table } from '@mc/ui';
import { notFound } from 'next/navigation';
import { publicSlots } from '@/lib/booking';
import { joinWaitlist } from '@/lib/booking-actions';
import { getDoctor, initials, languageName } from '@/lib/directory';
import { Flash } from '@/lib/flash';
import { SlotPicker } from '@/lib/slot-picker';
import { BookingPaused } from '@/lib/booking-paused';
import { publicModules } from '@/lib/modules';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

export default async function DoctorProfile({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string; ok?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const offered = await publicModules();
  if (!offered.modules.includes('directory')) {
    return <ZoneFrame zone="patient" path="/care/doctors" zones={ZONES} requireAuth={false}><BookingPaused /></ZoneFrame>;
  }
  const booking = offered.modules.includes('appointments');
  const d = await getDoctor(id).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  const slots = !booking ? { doctor: { id, name: '' }, days: [] } : await publicSlots(id).catch(() => ({ doctor: { id, name: d.name }, days: [] }));
  return (
    <ZoneFrame zone="patient" path="/care/doctors" zones={ZONES} requireAuth={false}>
      <div className="mc-card mc-doctor">
        <div className="mc-avatar" aria-hidden>{initials(d.name)}</div>
        <div>
          <h1 style={{ fontSize: '1.4rem' }}>{d.name}</h1>
          <p className="mc-meta">{d.specialties.map((s) => s.name).join(', ')}</p>
          <p className="mc-meta">{[d.qualifications.join(', '), d.experienceYears != null ? `${d.experienceYears} years of experience` : null].filter(Boolean).join(' · ')}</p>
          {d.languages.length ? <p className="mc-meta">Speaks {d.languages.map(languageName).join(', ')}</p> : null}
        </div>
        <div />
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      {!booking ? <BookingPaused /> : <Card title="Book an appointment">
        <div id="book" />
        <SlotPicker data={slots} selected={sp.date} dateHref={(date) => `/care/doctors/${id}?date=${date}#book`} slotHref={(slotId) => `/care/book/${slotId}`} />
        <form action={joinWaitlist} className="mc-form" style={{ marginTop: 20 }}>
          <input type="hidden" name="doctorId" value={id} />
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
