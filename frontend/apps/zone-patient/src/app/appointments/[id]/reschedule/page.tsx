import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Button, Card, PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { type Appointment, fmtDay, fmtTime, publicSlots, slotDetail } from '@/lib/booking';
import { rescheduleAppointment } from '@/lib/booking-actions';
import { Flash } from '@/lib/flash';
import { SlotPicker } from '@/lib/slot-picker';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

export default async function Reschedule({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string; slot?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const path = `/care/appointments/${id}/reschedule`;
  await zoneCapabilities('patient', path);
  const { accessToken: token } = (await getSession())!;
  const a = await api<Appointment>(`/api/scheduling/v1/appointments/${encodeURIComponent(id)}`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  const chosen = sp.slot ? await slotDetail(sp.slot).catch(() => null) : null;
  const slots = await publicSlots(a.doctor.id);
  return (
    <ZoneFrame zone="patient" path="/care/appointments" zones={ZONES}>
      <PageHeader title="Reschedule" subtitle={`${a.doctor.name} · now ${fmtDay(a.localDate)} at ${fmtTime(a.localTime)} for ${a.patient.name}`} />
      <Flash error={sp.error} />
      {chosen?.available ? (
        <Card title="Move to this time?">
          <p style={{ marginTop: 0 }}>{fmtDay(chosen.localDate, { weekday: 'long', day: 'numeric', month: 'long' })}, {fmtTime(chosen.localTime)} · {chosen.branch.name}</p>
          <form action={rescheduleAppointment} style={{ display: 'flex', gap: 12 }}>
            <input type="hidden" name="id" value={a.id} />
            <input type="hidden" name="newSlotId" value={chosen.slotId} />
            <Button>Confirm new time</Button>
            <a className="mc-btn mc-btn-ghost" href={path}>Pick another</a>
          </form>
        </Card>
      ) : (
        <Card title="Pick a new time">
          <SlotPicker data={slots} selected={sp.date} dateHref={(date) => `${path}?date=${date}`} slotHref={(slotId) => `${path}?slot=${slotId}`} />
        </Card>
      )}
      <p><a href="/care/appointments">← My appointments</a></p>
    </ZoneFrame>
  );
}
