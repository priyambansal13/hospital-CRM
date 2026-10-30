import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, Field, PageHeader, Select, Table } from '@mc/ui';
import { notFound } from 'next/navigation';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { staffAction } from '../actions';

export const dynamic = 'force-dynamic';

interface Staff { userId: string; email: string; name: string; status: string; createdAt: string; disabledAt: string | null; disabledReason: string | null; inviteSentAt: string | null }
interface Role { code: string; name: string }
interface Grant { roleCode: string; branchId: string | null }
interface Branch { id: string; name: string; active: boolean }

const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '');

/** One staff member: where they work and with which roles, and their account (reviews B-1, B-2). */
export default async function StaffMemberPage({ params, searchParams }: { params: Promise<{ userId: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { userId } = await params;
  const caps = await zoneCapabilities('admin', '/admin/staff');
  const { accessToken: token } = (await getSession())!;
  const s = await api<Staff>(`/api/iam/v1/staff/${userId}`, { token }).catch((e) => { if (e instanceof ApiError && e.status === 404) notFound(); throw e; });
  const canRoles = can(caps, 'role:read:tenant');
  const [roles, grants, branches] = await Promise.all([
    canRoles ? api<Role[]>('/api/entitlement/v1/roles', { token }) : Promise.resolve([] as Role[]),
    canRoles ? api<Grant[]>(`/api/entitlement/v1/users/${userId}/roles`, { token }).catch(() => [] as Grant[]) : Promise.resolve([] as Grant[]),
    api<Branch[]>('/api/tenant/v1/branches', { token }).catch(() => [] as Branch[]),
  ]);
  const roleName = Object.fromEntries(roles.map((r) => [r.code, r.name]));
  const branchName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const mine = caps.branchIds ?? null;
  const branchOptions = [
    ...(mine === null ? [{ value: '', label: 'Every branch' }] : []),
    ...branches.filter((b) => b.active && (mine === null || mine.includes(b.id))).map((b) => ({ value: b.id, label: b.name })),
  ];
  const self = caps.actor.id === userId;
  const manage = can(caps, 'staff:manage:tenant') && !self;
  const assign = can(caps, 'role:assign:tenant') && s.status !== 'DISABLED';
  const hidden = (op: string) => (<><input type="hidden" name="userId" value={userId} /><input type="hidden" name="op" value={op} /></>);

  return (
    <ZoneFrame zone="admin" path="/admin/staff" zones={ZONES}>
      <PageHeader title={s.name} subtitle={s.email} actions={<a href="/admin/staff">All staff</a>} />
      <Flash {...await searchParams} />
      <Card title="Account">
        <p>
          <Badge tone={s.status === 'ACTIVE' ? 'success' : s.status === 'DISABLED' ? 'danger' : 'warning'}>{s.status === 'DISABLED' ? 'deactivated' : s.status.toLowerCase()}</Badge>{' '}
          {s.status === 'INVITED' ? `Has not signed in yet${s.inviteSentAt ? ` (invite sent ${when(s.inviteSentAt)})` : ''}.` : null}
          {s.status === 'DISABLED' ? `Deactivated ${when(s.disabledAt)}${s.disabledReason ? `: ${s.disabledReason}` : ''}.` : null}
          {s.status === 'ACTIVE' ? `Staff since ${when(s.createdAt)}.` : null}
        </p>
        {self ? <Alert>This is your own account.</Alert> : null}
      </Card>

      {canRoles ? (
        <Card title="Roles">
          <Table
            rows={grants}
            empty={s.status === 'DISABLED' ? 'No roles: deactivated staff have none.' : 'No roles yet: they can sign in but see nothing.'}
            columns={[
              { header: 'Role', cell: (g) => roleName[g.roleCode] ?? g.roleCode },
              { header: 'Where', cell: (g) => (g.branchId ? branchName[g.branchId] ?? 'A closed branch' : 'Every branch') },
              ...(assign ? [{ header: '', cell: (g: Grant) => (
                <form action={staffAction}>{hidden('revoke')}<input type="hidden" name="role" value={g.roleCode} /><Button variant="ghost">Remove</Button></form>
              ) }] : []),
            ]}
          />
          {assign && roles.length ? (
            <form action={staffAction} className="mc-form">
              {hidden('grant')}
              <Select label="Give a role" name="role" required options={roles.filter((r) => r.code !== 'PATIENT').map((r) => ({ value: r.code, label: r.name }))} />
              <Select label="At" name="branchId" options={branchOptions} />
              <Button>Give role</Button>
            </form>
          ) : null}
        </Card>
      ) : null}

      {manage ? (
        <Card title="Sign-in">
          {s.status === 'INVITED' ? (
            <form action={staffAction}>{hidden('resend')}<p>The invite link is valid for 3 days. Send it again if it was lost or has expired.</p><Button variant="ghost">Resend invite</Button></form>
          ) : null}
          {s.status === 'ACTIVE' ? (
            <form action={staffAction} className="mc-form">
              {hidden('reset')}
              <p>They get an e-mail to set things up again, and are signed out everywhere now. You never see their password.</p>
              <label><input type="checkbox" name="password" defaultChecked /> New password</label>
              <label><input type="checkbox" name="authenticator" /> New authenticator app (lost or new phone)</label>
              <Button variant="ghost">Send reset e-mail</Button>
            </form>
          ) : null}
        </Card>
      ) : null}

      {manage ? (
        s.status === 'DISABLED' ? (
          <Card title="Reactivate">
            <form action={staffAction}>{hidden('reactivate')}<p>They can sign in again. Give them their roles again afterwards.</p><Button>Reactivate</Button></form>
          </Card>
        ) : (
          <Card title="Deactivate">
            <form action={staffAction} className="mc-form">
              {hidden('deactivate')}
              <p>For someone leaving: all their roles are removed, they are signed out at once and can no longer sign in to this hospital. Their past work (notes, reports, payments) stays.</p>
              <Field label="Reason" name="reason" required placeholder="Left the hospital on 30 October" />
              <label><input type="checkbox" name="confirm" value="yes" /> I understand {s.name} loses access now</label>
              <Button variant="danger">Deactivate</Button>
            </form>
          </Card>
        )
      ) : null}
    </ZoneFrame>
  );
}
