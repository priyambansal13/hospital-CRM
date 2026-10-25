import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { type ScheduleData, ScheduleEditor } from '@mc/schedule-ui';
import { PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { Flash } from '@/lib/flash';
import { addHours, addLeave, removeHours, removeLeave } from '@/lib/schedule-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

export default async function DoctorSchedule({ params, searchParams }: { params: Promise<{ doctorId: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { doctorId } = await params;
  await zoneCapabilities('admin', `/admin/schedules/${doctorId}`);
  const { accessToken: token } = (await getSession())!;
  const data = await api<ScheduleData>(`/api/scheduling/v1/doctors/${encodeURIComponent(doctorId)}/schedule`, { token })
    .catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  const back = `/admin/schedules/${data.doctor.id}`;
  return (
    <ZoneFrame zone="admin" path="/admin/schedules" zones={ZONES}>
      <PageHeader title={data.doctor.name} subtitle="Working hours, leave and upcoming slots." />
      <Flash {...await searchParams} />
      <ScheduleEditor data={data} back={back} actions={{ addHours, removeHours, addLeave, removeLeave }} />
      <p><a href="/admin/schedules">← All schedules</a></p>
    </ZoneFrame>
  );
}
