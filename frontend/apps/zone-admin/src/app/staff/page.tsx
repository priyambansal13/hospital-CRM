import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Select, Table } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { inviteStaff } from './actions';

export const dynamic = 'force-dynamic';

interface Staff { userId: string; email: string; name: string; status: string }
interface Role { code: string; name: string }

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('admin', '/admin/staff');
  const { accessToken: token } = (await getSession())!;
  const canRoles = can(caps, 'role:read:tenant');
  const [staff, roles] = await Promise.all([
    api<Staff[]>('/api/iam/v1/staff', { token }),
    canRoles ? api<Role[]>('/api/entitlement/v1/roles', { token }) : Promise.resolve([] as Role[]),
  ]);
  const rolesByUser = canRoles
    ? Object.fromEntries(await Promise.all(staff.map(async (s) => [s.userId, (await api<{ roleCode: string }[]>(`/api/entitlement/v1/users/${s.userId}/roles`, { token }).catch(() => [])).map((r) => r.roleCode)] as const)))
    : {};
  const roleName = Object.fromEntries(roles.map((r) => [r.code, r.name]));
  return (
    <ZoneFrame zone="admin" path="/admin/staff" zones={ZONES}>
      <PageHeader title="Staff" subtitle="People who can sign in to this hospital's portals." />
      <Flash {...await searchParams} />
      {can(caps, 'staff:invite:tenant') && roles.length ? (
        <Card title="Invite a staff member">
          <form action={inviteStaff} className="mc-form">
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <Field label="Full name" name="name" required placeholder="Dr. Asha Rao" />
            <Field label="Email" name="email" type="email" required autoComplete="off" />
            <Select label="Role" name="role" required options={roles.filter((r) => r.code !== 'PATIENT').map((r) => ({ value: r.code, label: r.name }))} />
            <Button>Send invite</Button>
          </form>
        </Card>
      ) : null}
      <Card title={`Staff (${staff.length})`}>
        <Table
          rows={staff}
          empty="No staff yet."
          columns={[
            { header: 'Name', cell: (s) => s.name },
            { header: 'Email', cell: (s) => s.email },
            { header: 'Roles', cell: (s) => (rolesByUser[s.userId] ?? []).map((r) => roleName[r] ?? r).join(', ') || '—' },
            { header: 'Status', cell: (s) => <Badge tone={s.status === 'ACTIVE' ? 'success' : 'warning'}>{s.status.toLowerCase()}</Badge> },
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
