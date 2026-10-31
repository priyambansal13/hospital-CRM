import { getSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Card, Columns, Icon, Kpi, PageHeader } from '@mc/ui';
import { redirect } from 'next/navigation';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface QueueAppt { id: string; appointmentNo: string; status: string; tokenNo: number | null; source: string; patient: { name: string; mrn: string }; branch: { name: string }; localTime: string; reason: string | null; checkedInAt: string | null }
interface Appt { id: string; status: string; localDate: string }
interface Critical { id: string; patient: { name: string }; test: string; parameter: string; value: string; unit: string | null; acknowledgedAt: string | null }
const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
const minutes = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000)) : 0);
const weekday = (d: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

/**
 * The doctor's "Today": who is in the room or next, who is waiting, notes still to sign, critical lab values, and the
 * week's bookings. Doctors without a directory profile go to their schedule (it explains what is missing).
 */
export default async function DoctorToday() {
  await zoneCapabilities('doctor', '/doctor');
  const { accessToken: token } = (await getSession())!;
  const me = await api<{ id: string; name: string }>('/api/scheduling/v1/me/doctor', { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
  if (!me) redirect(`${await origin()}/doctor/schedule`);
  const [queue, week, unsigned, critical] = await Promise.all([
    soft(api<{ appointments: QueueAppt[] }>(`/api/scheduling/v1/doctors/${me.id}/queue`, { token }), { appointments: [] }),
    soft(api<Appt[]>(`/api/scheduling/v1/doctors/${me.id}/appointments?days=7`, { token }), []),
    soft(api<{ encounterId: string; appointmentId: string | null; patient: { name: string } }[]>('/api/records/v1/encounters/unsigned', { token }), []),
    soft(api<Critical[]>('/api/diagnostics/v1/doctor/critical-alerts', { token }), []),
  ]);
  const q = queue.appointments;
  const inRoom = q.find((a) => a.status === 'IN_PROGRESS');
  const waiting = q.filter((a) => a.status === 'CHECKED_IN').sort((a, b) => (a.tokenNo ?? 999) - (b.tokenNo ?? 999));
  const done = q.filter((a) => a.status === 'COMPLETED').length;
  const notYet = q.filter((a) => ['CONFIRMED', 'PENDING_PAYMENT'].includes(a.status)).length;
  const next = inRoom ?? waiting[0];
  const open = critical.filter((c) => !c.acknowledgedAt);
  const days = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + i * 86_400_000)));
  const live = week.filter((a) => !['CANCELLED', 'EXPIRED', 'RESCHEDULED'].includes(a.status));
  const hour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date()));

  return (
    <ZoneFrame zone="doctor" path="/doctor" zones={ZONES}>
      <PageHeader
        title={`${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}, ${me.name}`}
        subtitle={new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }).format(new Date())}
        actions={<><a className="mc-btn mc-btn-ghost" href="/doctor/appointments">Appointments</a><a className="mc-btn mc-btn-primary" href="/doctor/queue">Open today&apos;s queue</a></>}
      />
      {open.length ? (
        <Alert tone="error"><strong>{open.length} critical lab value{open.length === 1 ? '' : 's'} for your patients:</strong> {open.slice(0, 3).map((c) => `${c.patient.name} (${c.parameter} ${c.value}${c.unit ? ` ${c.unit}` : ''})`).join('; ')}. <a href="/doctor/lab-results">Acknowledge</a></Alert>
      ) : null}

      <div className="mc-kpis">
        <Kpi label="Patients today" icon="users" value={q.length} sub={`${notYet} not arrived yet`} href="/doctor/queue" />
        <Kpi label="Waiting" icon="clock" tone={waiting.length > 3 ? 'warning' : undefined} value={waiting.length} sub={waiting[0] ? `longest ${minutes(waiting[0].checkedInAt)} min` : 'Nobody waiting'} href="/doctor/queue" />
        <Kpi label="Seen today" icon="shield" tone="success" value={done} />
        <Kpi label="Notes to sign" icon="file" tone={unsigned.length ? 'warning' : undefined} value={unsigned.length} sub={unsigned.length ? 'Finish them today' : 'All signed'} href="/doctor/queue" />
      </div>

      <div className="mc-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Card title={inRoom ? 'With you now' : 'Next patient'}>
          {next ? (
            <div className="mc-next" style={{ cursor: 'default' }}>
              <span className="mc-token" aria-hidden>{next.tokenNo ?? next.localTime}</span>
              <span>
                <strong>{next.patient.name}</strong>
                <span>{next.patient.mrn} · {next.branch.name} · {next.source === 'WALK_IN' ? 'walk-in' : `booked ${next.localTime}`}{next.reason ? ` · ${next.reason}` : ''}</span>
              </span>
              <a className="mc-btn mc-btn-primary" href={`/doctor/consult/${next.id}`}>{inRoom ? 'Continue visit' : 'Open visit'}</a>
            </div>
          ) : <p className="mc-empty">Nobody waiting right now.</p>}
          {waiting.length > (inRoom ? 0 : 1) ? (
            <ul className="mc-queue" style={{ marginTop: 12 }} aria-label="Waiting">
              {waiting.slice(inRoom ? 0 : 1, (inRoom ? 0 : 1) + 4).map((a) => (
                <li key={a.id} className="mc-queue-item">
                  <span className="mc-token">{a.tokenNo ?? '—'}</span>
                  <div><strong>{a.patient.name}</strong><span className="mc-meta">waiting {minutes(a.checkedInAt)} min{a.reason ? ` · ${a.reason}` : ''}</span></div>
                  <Badge>{a.branch.name}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        <Card title="Your week">
          <Columns rows={days.map((d, i) => ({ label: i === 0 ? 'Today' : weekday(d), value: live.filter((a) => a.localDate === d).length }))} />
          <p className="mc-meta" style={{ marginBottom: 0 }}>{live.length} patients booked in the next 7 days</p>
        </Card>
        <Card title="To do">
          {unsigned.length || open.length ? (
            <ul className="mc-queue">
              {open.slice(0, 3).map((c) => (
                <li key={c.id} className="mc-queue-item">
                  <span className="mc-kpi-icon" style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)', color: 'var(--danger)' }}><Icon name="alert" /></span>
                  <div><strong>Critical value: {c.patient.name}</strong><span className="mc-meta">{c.test}: {c.parameter} {c.value}{c.unit ? ` ${c.unit}` : ''}</span></div>
                  <a className="mc-btn mc-btn-ghost" href="/doctor/lab-results">Review</a>
                </li>
              ))}
              {unsigned.slice(0, 4).map((u) => (
                <li key={u.encounterId} className="mc-queue-item">
                  <span className="mc-kpi-icon"><Icon name="file" /></span>
                  <div><strong>Sign the notes: {u.patient.name}</strong><span className="mc-meta">Visit notes still open</span></div>
                  {u.appointmentId ? <a className="mc-btn mc-btn-ghost" href={`/doctor/consult/${u.appointmentId}`}>Open</a> : <span />}
                </li>
              ))}
            </ul>
          ) : <p className="mc-empty">Nothing waiting for you. Well done.</p>}
        </Card>
      </div>
    </ZoneFrame>
  );
}
