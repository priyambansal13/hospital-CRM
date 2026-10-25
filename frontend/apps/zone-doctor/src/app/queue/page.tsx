import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, PageHeader } from '@mc/ui';
import type { ReactNode } from 'react';
import { LiveRefresh } from '@mc/ui/live';
import { Flash } from '@/lib/flash';
import { completeVisit, markNoShow, startVisit } from '@/lib/queue-actions';
import { finishSignLater } from '@/lib/visit-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Appt {
  id: string; appointmentNo: string; status: string; tokenNo: number | null; source: string; mode: string;
  patient: { name: string; mrn: string }; branch: { name: string }; localTime: string; reason: string | null; startsAt: string; checkedInAt: string | null;
}

const since = (iso: string | null) => (iso ? `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))} min` : '');

function Token({ a }: { a: Appt }) {
  return a.tokenNo ? <span className="mc-token" aria-label={`Token ${a.tokenNo}`}>{a.tokenNo}</span> : <span className="mc-token mc-token-none">{a.localTime}</span>;
}

function Row({ a, now, children }: { a: Appt; now?: boolean; children?: ReactNode }) {
  return (
    <li className={`mc-queue-item${now ? ' now' : ''}`} data-testid={`queue-${a.appointmentNo}`}>
      <Token a={a} />
      <div>
        <strong>{a.patient.name}</strong>
        <span className="mc-meta">
          {a.patient.mrn} · {a.mode === 'VIDEO' ? 'Video' : a.branch.name} · {a.source === 'WALK_IN' ? 'walk-in' : `booked ${a.localTime}`}
          {a.status === 'CHECKED_IN' && a.checkedInAt ? ` · waiting ${since(a.checkedInAt)}` : ''}
          {a.reason ? ` · ${a.reason}` : ''}
        </span>
      </div>
      <div className="mc-inline">{children}</div>
    </li>
  );
}

function Act({ action, id, label, variant }: { action: (f: FormData) => Promise<void>; id: string; label: string; variant?: 'primary' | 'ghost' | 'danger' }) {
  return (
    <form action={action} className="mc-inline">
      <input type="hidden" name="id" value={id} />
      <Button variant={variant}>{label}</Button>
    </form>
  );
}

/** The doctor's live queue for today: who is being seen, who is waiting (by token), who hasn't arrived. */
export default async function TodaysQueue({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; unsigned?: string }> }) {
  const sp = await searchParams;
  await zoneCapabilities('doctor', '/doctor/queue');
  const { accessToken: token } = (await getSession())!;
  const me = await api<{ id: string; name: string }>('/api/scheduling/v1/me/doctor', { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
  const q = me ? await api<{ appointments: Appt[] }>(`/api/scheduling/v1/doctors/${me.id}/queue`, { token }) : { appointments: [] };
  const by = (...s: string[]) => q.appointments.filter((a) => s.includes(a.status));
  const [current, waiting, notArrived, done] = [by('IN_PROGRESS'), by('CHECKED_IN'), by('CONFIRMED'), by('COMPLETED', 'NO_SHOW')];
  const due = (a: Appt) => Date.parse(a.startsAt) <= Date.now();
  // notes still to sign (finished on purpose, or older visits): never lost
  const unsigned = me ? await api<{ encounterId: string; appointmentId: string | null; startedAt: string; patient: { name: string; mrn: string } }[]>('/api/records/v1/encounters/unsigned', { token }).catch(() => []) : [];

  return (
    <ZoneFrame zone="doctor" path="/doctor/queue" zones={ZONES}>
      <PageHeader title="Today's queue" subtitle={`${waiting.length} waiting · ${current.length ? 'seeing a patient' : 'free'} · ${done.length} done`} actions={me ? <LiveRefresh src={`/doctor/live?doctorId=${me.id}`} /> : null} />
      <Flash ok={sp.ok} error={sp.error} />
      {!me ? <Card><p className="mc-muted">Your account isn&apos;t linked to a doctor profile.</p></Card> : (
        <>
          {unsigned.length ? (
            <Card title={`Unsigned notes (${unsigned.length})`}>
              <ul className="mc-list" aria-label="Unsigned notes">{unsigned.map((u) => (
                <li key={u.encounterId}>
                  {u.appointmentId ? <a href={`/doctor/consult/${u.appointmentId}`}>{u.patient.name}</a> : u.patient.name}
                  <span className="mc-meta"> · {u.patient.mrn} · {new Date(u.startedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}</span>
                </li>
              ))}</ul>
            </Card>
          ) : null}
          <Card title="Now seeing">
            {current.length ? (
              <ul className="mc-queue">{current.map((a) => (
                <Row key={a.id} a={a} now>
                  <a className="mc-btn mc-btn-primary" href={`/doctor/consult/${a.id}`}>Open visit</a>
                  <Act action={completeVisit} id={a.id} label="Complete visit" variant="ghost" />
                  {sp.unsigned === a.id ? <Act action={finishSignLater} id={a.id} label="Finish, sign the note later" variant="ghost" /> : null}
                </Row>
              ))}</ul>
            ) : <p className="mc-empty">Nobody right now. Call in the next patient from the waiting list.</p>}
          </Card>

          <h2 className="mc-section-title">Waiting ({waiting.length})</h2>
          {waiting.length ? (
            <ul className="mc-queue" aria-label="Waiting">{waiting.map((a, i) => (
              <Row key={a.id} a={a}>
                <Act action={startVisit} id={a.id} label={i === 0 ? 'Call in' : 'Start'} variant={i === 0 && !current.length ? 'primary' : 'ghost'} />
                <Act action={markNoShow} id={a.id} label="Left" variant="ghost" />
              </Row>
            ))}</ul>
          ) : <p className="mc-empty">No one has checked in yet.</p>}

          <h2 className="mc-section-title">Not arrived yet ({notArrived.length})</h2>
          {notArrived.length ? (
            <ul className="mc-queue">{notArrived.map((a) => (
              <Row key={a.id} a={a}>
                {a.mode === 'VIDEO' ? <Act action={startVisit} id={a.id} label="Start video visit" variant="ghost" /> : <Badge>booked</Badge>}
                {due(a) ? <Act action={markNoShow} id={a.id} label="No-show" variant="ghost" /> : null}
              </Row>
            ))}</ul>
          ) : <p className="mc-empty">No more bookings today.</p>}

          {done.length ? (
            <>
              <h2 className="mc-section-title">Done ({done.length})</h2>
              <ul className="mc-queue">{done.map((a) => (
                <Row key={a.id} a={a}>
                  <Badge tone={a.status === 'COMPLETED' ? 'success' : 'warning'}>{a.status === 'COMPLETED' ? 'completed' : 'no-show'}</Badge>
                  {a.status === 'COMPLETED' ? <a className="mc-btn mc-btn-ghost" href={`/doctor/consult/${a.id}`}>Notes</a> : null}
                </Row>
              ))}</ul>
            </>
          ) : null}
        </>
      )}
    </ZoneFrame>
  );
}
