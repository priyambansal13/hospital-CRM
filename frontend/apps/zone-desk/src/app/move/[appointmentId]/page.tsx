import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Button, Card, Chip, PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { moveAppointment } from '@/lib/desk-actions';
import { type Appt, nextDays } from '@/lib/desk';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Slot { slotId: string; localTime: string; now: boolean }

/** E-1: move a booking to another time with the same doctor (the payment travels with it). */
export default async function MoveAppointment({ params, searchParams }: { params: Promise<{ appointmentId: string }>; searchParams: Promise<{ date?: string; back?: string; ok?: string; error?: string }> }) {
  const { appointmentId } = await params;
  const sp = await searchParams;
  const caps = await zoneCapabilities('desk', '/desk');
  if (!can(caps, 'appointment:cancel:branch')) notFound();
  const { accessToken: token } = (await getSession())!;
  const a = await api<Appt>(`/api/scheduling/v1/appointments/${appointmentId}`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
  if (!a) notFound();
  const days = nextDays(14);
  const date = days.find((d) => d.date === sp.date)?.date ?? days[0].date;
  const slots = await api<Slot[]>(`/api/scheduling/v1/desk/doctors/${a.doctor.id}/slots?branchId=${a.branch.id}&date=${date}`, { token }).catch(() => [] as Slot[]);
  const back = sp.back?.startsWith('/desk') ? sp.back : '/desk';
  const link = (d: string) => `/desk/move/${appointmentId}?${new URLSearchParams({ date: d, back })}`;
  return (
    <ZoneFrame zone="desk" path="/desk" zones={ZONES}>
      <PageHeader title={`Move ${a.patient.name}'s visit`} subtitle={`${a.appointmentNo} · ${a.doctor.name} · ${a.branch.name} · now ${a.localDate} ${a.localTime}`} actions={<a href={back}>Back</a>} />
      <Flash ok={sp.ok} error={sp.error} />
      {a.status !== 'CONFIRMED' ? <Alert>Only a booked visit (not checked in, not finished) can be moved.</Alert> : (
        <>
          <div className="mc-chips">{days.map((d) => <Chip key={d.date} href={link(d.date)} active={d.date === date}>{d.label}</Chip>)}</div>
          <Card title={`Free times with ${a.doctor.name}`}>
            {slots.length ? (
              <form action={moveAppointment} className="mc-form">
                <input type="hidden" name="id" value={appointmentId} />
                <input type="hidden" name="back" value={back} />
                <fieldset className="mc-fieldset mc-field-wide">
                  <legend>Time</legend>
                  <div className="mc-radios">
                    {slots.map((s) => (
                      <label key={s.slotId} className="mc-radio"><input type="radio" name="slotId" value={s.slotId} required /> <span>{s.localTime}</span></label>
                    ))}
                  </div>
                </fieldset>
                <Button>Move here</Button>
              </form>
            ) : <p className="mc-muted">No free times on this day. Try another day.</p>}
          </Card>
        </>
      )}
    </ZoneFrame>
  );
}
