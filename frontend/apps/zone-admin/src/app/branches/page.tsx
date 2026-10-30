import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { createBranch, setBranchActive } from './actions';

export const dynamic = 'force-dynamic';

interface Branch { id: string; name: string; city: string; timezone: string; active: boolean; version: number; address: { pincode?: string } }

export default async function Branches({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('admin', '/admin/branches');
  const { accessToken: token } = (await getSession())!;
  const branches = await api<Branch[]>('/api/tenant/v1/branches', { token });
  const manage = can(caps, 'branch:manage:tenant');
  // closing a branch cancels its future bookings: show how many (review D-5)
  const upcoming: Record<string, number> = manage ? Object.fromEntries(await Promise.all(branches.filter((b) => b.active).map(async (b) =>
    [b.id, (await api<{ upcoming: number }>(`/api/scheduling/v1/upcoming-appointments?branchId=${b.id}`, { token }).catch(() => ({ upcoming: 0 }))).upcoming] as const))) : {};
  return (
    <ZoneFrame zone="admin" path="/admin/branches" zones={ZONES}>
      <PageHeader title="Branches" subtitle="Locations where your hospital sees patients." />
      <Flash {...await searchParams} />
      {manage ? (
        <Card title="Add a branch">
          <form action={createBranch} className="mc-form">
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <Field label="Name" name="name" required placeholder="Sector 44" />
            <Field label="City" name="city" required placeholder="Gurugram" />
            <Field label="Pincode" name="pincode" inputMode="numeric" pattern="\d{6}" placeholder="122003" />
            <Button>Add branch</Button>
          </form>
        </Card>
      ) : null}
      <Card title={`All branches (${branches.length})`}>
        <Table
          rows={branches}
          empty="No branches yet. Add your first location above."
          columns={[
            { header: 'Name', cell: (b) => (manage ? <a href={`/admin/branches/${b.id}`}>{b.name}</a> : b.name) },
            { header: 'Time zone', cell: (b) => <span className="mc-meta">{b.timezone}</span> },
            { header: 'City', cell: (b) => b.city },
            { header: 'Pincode', cell: (b) => b.address?.pincode ?? '—' },
            { header: 'Status', cell: (b) => <Badge tone={b.active ? 'success' : 'neutral'}>{b.active ? 'Active' : 'Inactive'}</Badge> },
            ...(manage ? [{
              header: 'Action',
              cell: (b: Branch) => (
                <form action={setBranchActive}>
                  <input type="hidden" name="id" value={b.id} />
                  <input type="hidden" name="version" value={b.version} />
                  <input type="hidden" name="active" value={String(!b.active)} />
                  <input type="hidden" name="upcoming" value={upcoming[b.id] ?? 0} />
                  {b.active && upcoming[b.id] ? <label className="mc-check"><input type="checkbox" name="confirm" required /> Cancel {upcoming[b.id]} upcoming appointment{upcoming[b.id] === 1 ? '' : 's'}</label> : null}
                  <Button variant="ghost">{b.active ? 'Deactivate' : 'Activate'}</Button>
                </form>
              ),
            }] : []),
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
