import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { saveHomeWindows } from '../branches/edit-actions';
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
      {windows.map(({ branch, windows: w }) => {
        const rows: (Win | null)[] = [...w, null, null, null];
        return (
          <Card key={branch.id} title={`Home visit times · ${branch.name}`}>
            {/* E-5: edit the windows (was read-only) */}
            <form action={saveHomeWindows} className="mc-form" aria-label={`Home visit times at ${branch.name}`}>
              <input type="hidden" name="branchId" value={branch.id} />
              <input type="hidden" name="rows" value={rows.length} />
              <div className="mc-field-wide" style={{ overflowX: 'auto' }}>
                <table className="mc-table">
                  <thead><tr><th>Day</th><th>From</th><th>To</th><th>Visit length</th><th>At a time</th></tr></thead>
                  <tbody>{rows.map((x, i) => (
                    <tr key={i}>
                      <td><select name={`day${i}`} defaultValue={x ? String(x.day) : ''} className="mc-select-sm" aria-label={`Day ${i + 1}`}><option value="">—</option>{[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{DAYS[d]}</option>)}</select></td>
                      <td><input type="time" name={`start${i}`} defaultValue={x?.start} className="mc-input-sm" aria-label={`From ${i + 1}`} /></td>
                      <td><input type="time" name={`end${i}`} defaultValue={x?.end} className="mc-input-sm" aria-label={`To ${i + 1}`} /></td>
                      <td><select name={`slot${i}`} defaultValue={String(x?.slotMinutes ?? 30)} className="mc-select-sm" aria-label={`Visit length ${i + 1}`}>{[15, 20, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}</select></td>
                      <td><input name={`cap${i}`} type="number" min={1} max={50} defaultValue={x?.capacity ?? 2} className="mc-input-sm" style={{ width: 70 }} aria-label={`At a time ${i + 1}`} /></td>
                    </tr>
                  ))}</tbody>
                </table>
                <small className="mc-muted">Clear a row&apos;s day to remove it. Visits already booked keep their time.</small>
              </div>
              <Button variant="ghost">Save times</Button>
            </form>
          </Card>
        );
      })}
    </ZoneFrame>
  );
}
