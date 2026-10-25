import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { type ScheduleData, ScheduleEditor } from '@mc/schedule-ui';
import { Card, PageHeader } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { addHours, addLeave, removeHours, removeLeave } from '@/lib/schedule-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

export default async function MySchedule({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await zoneCapabilities('doctor', '/doctor/schedule');
  const { accessToken: token } = (await getSession())!;
  const me = await api<{ id: string; name: string }>('/api/scheduling/v1/me/doctor', { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
  const data = me ? await api<ScheduleData>(`/api/scheduling/v1/doctors/${me.id}/schedule`, { token }) : null;
  return (
    <ZoneFrame zone="doctor" path="/doctor/schedule" zones={ZONES}>
      <PageHeader title="My schedule" subtitle="Set the hours patients can book, and block days when you are away." />
      <Flash {...await searchParams} />
      {data ? (
        <ScheduleEditor data={data} back="/doctor/schedule" actions={{ addHours, removeHours, addLeave, removeLeave }} />
      ) : (
        <Card title="No doctor profile yet">
          <p className="mc-muted">Your account isn&apos;t linked to a doctor profile. Ask your hospital admin to add you under Doctors.</p>
        </Card>
      )}
    </ZoneFrame>
  );
}
