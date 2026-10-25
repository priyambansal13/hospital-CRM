import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, PageHeader } from '@mc/ui';
import { type Appointment, fmtDay, fmtTime, myAppointments } from '@/lib/booking';
import { cancelAppointment } from '@/lib/booking-actions';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  CONFIRMED: { label: 'Confirmed', tone: 'success' }, PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'warning' },
  CHECKED_IN: { label: 'Checked in', tone: 'success' }, IN_PROGRESS: { label: 'With the doctor', tone: 'success' },
  COMPLETED: { label: 'Completed', tone: 'neutral' }, CANCELLED: { label: 'Cancelled', tone: 'danger' }, NO_SHOW: { label: 'Missed', tone: 'warning' }, EXPIRED: { label: 'Not paid in time', tone: 'neutral' },
};
const feeLine = (a: Appointment) => {
  const fee = `₹${a.fee}`;
  switch (a.paymentStatus) {
    case 'PAID': return `${fee} paid`;
    case 'REFUNDED': return `${fee} refunded`;
    case 'PARTIALLY_REFUNDED': return `${fee} paid, partly refunded`;
    default: return a.status === 'PENDING_PAYMENT' ? `${fee} to pay${a.holdExpiresAt ? ` by ${new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(a.holdExpiresAt))}` : ''}` : a.paymentMode === 'ONLINE' ? `${fee} not paid` : `${fee}, pay at the hospital`;
  }
};
const CANCEL_REASON: Record<string, string> = { DOCTOR_UNAVAILABLE: 'The doctor is unavailable that day.', PATIENT_CANCELLED: 'You cancelled.', CANCELLED_BY_HOSPITAL: 'Cancelled by the hospital.' };

function AppointmentCard({ a, actions, windowHours }: { a: Appointment; actions: boolean; windowHours: number }) {
  const s = STATUS[a.status] ?? { label: a.status, tone: 'neutral' as const };
  const changeable = actions && a.status === 'CONFIRMED' && new Date(a.startsAt).getTime() - Date.now() > windowHours * 3600_000;
  return (
    <article className="mc-card mc-appt" aria-label={`Appointment ${a.appointmentNo}`}>
      <div>
        <h3>{fmtDay(a.localDate, { weekday: 'long', day: 'numeric', month: 'long' })}, {fmtTime(a.localTime)}</h3>
        <p className="mc-meta" style={{ margin: '4px 0 0' }}>{a.doctor.name} · {a.mode === 'VIDEO' ? 'Video' : a.branch.name}</p>
        <p className="mc-meta" style={{ margin: '2px 0 0' }}>For {a.patient.name} · {a.appointmentNo}{a.fee ? ` · ${feeLine(a)}` : ''}</p>
        {a.status === 'CANCELLED' && a.cancelReason ? <p className="mc-meta" style={{ margin: '2px 0 0' }}>{CANCEL_REASON[a.cancelReason] ?? a.cancelReason}</p> : null}
      </div>
      <div className="mc-appt-actions">
        <Badge tone={s.tone}>{s.label}</Badge>
        {a.status === 'PENDING_PAYMENT' && a.invoiceId ? <a className="mc-btn mc-btn-primary" href={`/care/pay/${a.invoiceId}`}>Pay now</a> : null}
        {changeable ? (
          <>
            <a className="mc-btn mc-btn-ghost" href={`/care/appointments/${a.id}/reschedule`}>Reschedule</a>
            <form action={cancelAppointment}>
              <input type="hidden" name="id" value={a.id} />
              <Button variant="ghost">Cancel</Button>
            </form>
          </>
        ) : null}
      </div>
    </article>
  );
}

export default async function MyAppointmentsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('patient', '/care/appointments');
  if (caps.actor.kind !== 'patient') {
    return <ZoneFrame zone="patient" path="/care/appointments" zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  }
  const { accessToken: token } = (await getSession())!;
  const [data, waitlist] = await Promise.all([
    myAppointments(token),
    api<{ id: string; doctor: { name: string }; patient: { name: string }; date: string; notifiedAt: string | null }[]>('/api/scheduling/v1/me/waitlist', { token }),
  ]);
  return (
    <ZoneFrame zone="patient" path="/care/appointments" zones={ZONES}>
      <PageHeader title="My appointments" subtitle={`You can cancel or reschedule online up to ${data.policy.cancelWindowHours} hours before.`} actions={<a className="mc-btn mc-btn-primary" href="/care/doctors">Book another</a>} />
      <Flash {...await searchParams} />
      <section className="mc-list" aria-label="Upcoming">
        <h2>Upcoming</h2>
        {data.upcoming.length ? data.upcoming.map((a) => <AppointmentCard key={a.id} a={a} actions windowHours={data.policy.cancelWindowHours} />) : <p className="mc-muted">No upcoming appointments.</p>}
      </section>
      {waitlist.length ? (
        <Card title="Waitlist">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {waitlist.map((w) => <li key={w.id}>{w.doctor.name} on {fmtDay(w.date)} for {w.patient.name}{w.notifiedAt ? ' · a time opened up, book it now' : ''}</li>)}
          </ul>
        </Card>
      ) : null}
      {data.past.length ? (
        <section className="mc-list" aria-label="Past and cancelled">
          <h2>Past and cancelled</h2>
          {data.past.map((a) => <AppointmentCard key={a.id} a={a} actions={false} windowHours={data.policy.cancelWindowHours} />)}
        </section>
      ) : null}
    </ZoneFrame>
  );
}
