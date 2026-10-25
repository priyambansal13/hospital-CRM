import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Button, Card, PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { type Doctor, listBranches, listSpecialties } from '@/lib/directory';
import { DoctorFields, statusBadge } from '@/lib/doctor-form';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { setDoctorStatus, updateDoctor } from '../actions';

export const dynamic = 'force-dynamic';

export default async function EditDoctor({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  await zoneCapabilities('admin', `/admin/doctors/${id}`);
  const { accessToken: token } = (await getSession())!;
  const doctor = await api<Doctor>(`/api/provider/v1/doctors/${id}`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  const [specialties, branches] = await Promise.all([listSpecialties(token), listBranches(token)]);
  // unpublishing cancels the doctor's future bookings: say how many, and ask (review D-5)
  const upcoming = doctor.status === 'ACTIVE' ? (await api<{ upcoming: number }>(`/api/scheduling/v1/upcoming-appointments?doctorId=${id}`, { token }).catch(() => ({ upcoming: 0 }))).upcoming : 0;
  return (
    <ZoneFrame zone="admin" path="/admin/doctors" zones={ZONES}>
      <PageHeader
        title={doctor.name}
        subtitle={`${doctor.email} · Reg. ${doctor.registrationNo}`}
        actions={
          <form action={setDoctorStatus} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {statusBadge(doctor.status)}
            <input type="hidden" name="id" value={doctor.id} />
            <input type="hidden" name="back" value={`/doctors/${doctor.id}`} />
            <input type="hidden" name="status" value={doctor.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'} />
            <input type="hidden" name="upcoming" value={upcoming} />
            {upcoming ? <label className="mc-check"><input type="checkbox" name="confirm" required /> Cancel {upcoming} upcoming appointment{upcoming === 1 ? '' : 's'}, refund and tell the patients</label> : null}
            <Button variant={doctor.status === 'ACTIVE' ? 'ghost' : 'primary'}>{doctor.status === 'ACTIVE' ? 'Unpublish' : 'Publish profile'}</Button>
          </form>
        }
      />
      <Flash {...await searchParams} />
      <Card title="Profile">
        <form action={updateDoctor} className="mc-form">
          <input type="hidden" name="id" value={doctor.id} />
          <input type="hidden" name="version" value={doctor.version} />
          <DoctorFields specialties={specialties} branches={branches} doctor={doctor} />
          <Button>Save changes</Button>
        </form>
      </Card>
      <p><a href="/admin/doctors">← All doctors</a></p>
    </ZoneFrame>
  );
}
