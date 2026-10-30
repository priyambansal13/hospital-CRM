import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Button, Card, Field, PageHeader, Select } from '@mc/ui';
import { notFound } from 'next/navigation';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { saveBranch } from '../edit-actions';

export const dynamic = 'force-dynamic';

interface Branch { id: string; name: string; city: string; timezone: string; active: boolean; version: number; address: { line1?: string; pincode?: string } }
const COMMON = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Colombo', 'Asia/Singapore', 'Europe/London', 'UTC'];

/** E-4: a branch's name, address and time zone (bookings and "today" at the branch follow its time zone). */
export default async function EditBranch({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const caps = await zoneCapabilities('admin', '/admin/branches');
  if (!can(caps, 'branch:manage:tenant')) notFound();
  const { accessToken: token } = (await getSession())!;
  const b = (await api<Branch[]>('/api/tenant/v1/branches', { token })).find((x) => x.id === id);
  if (!b) notFound();
  const zones = [...new Set([b.timezone, ...COMMON, ...Intl.supportedValuesOf('timeZone')])];
  return (
    <ZoneFrame zone="admin" path="/admin/branches" zones={ZONES}>
      <PageHeader title={b.name} subtitle={b.active ? 'Active' : 'Inactive'} actions={<a href="/admin/branches">All branches</a>} />
      <Flash {...await searchParams} />
      <Card>
        <form action={saveBranch} className="mc-form">
          <input type="hidden" name="id" value={b.id} />
          <input type="hidden" name="version" value={b.version} />
          <Field label="Name" name="name" required defaultValue={b.name} />
          <Field label="City" name="city" required defaultValue={b.city} />
          <Field label="Address" name="line1" defaultValue={b.address?.line1} />
          <Field label="Pincode" name="pincode" inputMode="numeric" pattern="\d{6}" defaultValue={b.address?.pincode} />
          <Select label="Time zone" name="timezone" defaultValue={b.timezone} options={zones.map((z) => ({ value: z, label: z.replace('_', ' ') }))} />
          <Alert>Changing the time zone changes what &quot;today&quot; and opening hours mean at this branch. Times already booked stay at the same moment.</Alert>
          <Button>Save</Button>
        </form>
      </Card>
    </ZoneFrame>
  );
}
