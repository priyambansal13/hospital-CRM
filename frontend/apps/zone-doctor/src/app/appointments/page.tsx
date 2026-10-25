import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Card, PageHeader, Table } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Appt { id: string; appointmentNo: string; status: string; patient: { name: string; mrn: string }; localDate: string; localTime: string; branch: { name: string }; mode: string; reason: string | null }
const fmtDay = (iso: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

/** The doctor's booked appointments for the coming week (today's live queue is on /doctor/queue). */
export default async function DoctorAppointments() {
  await zoneCapabilities('doctor', '/doctor/appointments');
  const { accessToken: token } = (await getSession())!;
  const me = await api<{ id: string }>('/api/scheduling/v1/me/doctor', { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
  const appts = me ? await api<Appt[]>(`/api/scheduling/v1/doctors/${me.id}/appointments?days=7`, { token }) : [];
  const byDay = new Map<string, Appt[]>();
  for (const a of appts) byDay.set(a.localDate, [...(byDay.get(a.localDate) ?? []), a]);
  return (
    <ZoneFrame zone="doctor" path="/doctor/appointments" zones={ZONES}>
      <PageHeader title="Appointments" subtitle="Booked patients for the next 7 days." />
      {!me ? <Card><p className="mc-muted">Your account isn&apos;t linked to a doctor profile.</p></Card> : null}
      {me && !appts.length ? <Card><p className="mc-muted" style={{ margin: 0 }}>No appointments booked in the next 7 days.</p></Card> : null}
      {[...byDay.entries()].map(([day, list]) => (
        <Card key={day} title={`${fmtDay(day)} · ${list.length} patient${list.length === 1 ? '' : 's'}`}>
          <Table
            rows={list}
            empty=""
            columns={[
              { header: 'Time', cell: (a) => a.localTime },
              { header: 'Patient', cell: (a) => `${a.patient.name} (${a.patient.mrn})` },
              { header: 'Reason', cell: (a) => a.reason ?? '—' },
              { header: 'Where', cell: (a) => (a.mode === 'VIDEO' ? 'Video' : a.branch.name) },
              { header: 'Status', cell: (a) => <Badge tone="success">{a.status.toLowerCase().replace('_', ' ')}</Badge> },
            ]}
          />
        </Card>
      ))}
    </ZoneFrame>
  );
}
