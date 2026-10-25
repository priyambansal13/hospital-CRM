import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { saveArea } from './actions';

export const dynamic = 'force-dynamic';

interface Area { id: string; pincode: string; area: string | null; fee: number; active: boolean; branch: { id: string; name: string } }
interface Win { day: number; start: string; end: string; slotMinutes: number; capacity: number }
const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Where the hospital collects samples at home (pincode → branch), the visit fee, and the home visit times. */
export default async function HomeCollection({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await zoneCapabilities('admin', '/admin/home-collection');
  const { accessToken: token } = (await getSession())!;
  const [areas, branches] = await Promise.all([
    api<Area[]>('/api/diagnostics/v1/admin/home-areas', { token }),
    api<{ id: string; name: string }[]>('/api/diagnostics/v1/public/lab-branches', { token }),
  ]);
  const used = branches.filter((b) => areas.some((a) => a.branch.id === b.id));
  const windows = await Promise.all(used.map(async (b) => ({ branch: b, windows: await api<Win[]>(`/api/diagnostics/v1/admin/home-windows/${b.id}`, { token }) })));
  return (
    <ZoneFrame zone="admin" path="/admin/home-collection" zones={ZONES}>
      <PageHeader title="Home collection" subtitle="Pincodes where a phlebotomist collects samples at home, the branch that serves each, and the visit fee." />
      <Flash {...await searchParams} />
      <Card title="Add a pincode">
        <form action={saveArea} className="mc-form" aria-label="Add a pincode">
          <input type="hidden" name="isNew" value="1" />
          <Field label="Pincode" name="pincode" required pattern="[1-9][0-9]{5}" inputMode="numeric" placeholder="122003" />
          <label className="mc-field"><span>Served by</span>
            <select name="branchId" required>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
          <Field label="Area name" name="area" placeholder="Sector 44, Gurugram" />
          <Field label="Visit fee (₹)" name="fee" type="number" defaultValue="0" />
          <Button>Add</Button>
        </form>
      </Card>
      <Card title={`Pincodes served (${areas.length})`}>
        <Table rows={areas} empty="None yet: patients can only book at the lab." columns={[
          { header: 'Pincode', cell: (a) => <><strong>{a.pincode}</strong>{a.area ? <span className="mc-meta"> {a.area}</span> : null}</> },
          { header: 'Branch', cell: (a) => a.branch.name },
          { header: 'Fee and availability', cell: (a) => (
            <form action={saveArea} className="mc-inline" aria-label={`Edit ${a.pincode}`}>
              <input type="hidden" name="pincode" value={a.pincode} /><input type="hidden" name="branchId" value={a.branch.id} /><input type="hidden" name="area" value={a.area ?? ''} />
              <input name="fee" type="number" min={0} step="1" defaultValue={a.fee} aria-label={`Fee for ${a.pincode}`} className="mc-input-sm" style={{ width: 90 }} />
              <label className="mc-check"><input type="checkbox" name="active" defaultChecked={a.active} /> <span>on</span></label>
              <button className="mc-btn mc-btn-ghost">Save</button>
            </form>
          ) },
          { header: '', cell: (a) => (a.active ? <Badge tone="success">bookable</Badge> : <Badge>off</Badge>) },
        ]} />
      </Card>
      {windows.map(({ branch, windows: w }) => (
        <Card key={branch.id} title={`Home visit times · ${branch.name}`}>
          <p className="mc-meta" style={{ marginTop: 0 }}>{w.length ? w.map((x) => `${DAYS[x.day]} ${x.start}–${x.end} (${x.slotMinutes}-min visits, ${x.capacity} at a time)`).join(' · ') : 'No home visit times: patients cannot book a home collection here.'}</p>
        </Card>
      ))}
    </ZoneFrame>
  );
}
