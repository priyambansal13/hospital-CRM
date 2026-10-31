import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Upsell } from '@mc/features/plan';
import { Badge, Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { createRole, deleteRole, giveRole, saveRole, takeRole } from './actions';

export const dynamic = 'force-dynamic';

interface Role { code: string; name: string; isSystem: boolean; grantsAll: boolean; customized: boolean; basedOn: string | null; description: string | null; permissions: string[]; users: number; editable: boolean }
interface Editor { roles: Role[]; catalogue: { module: string; name: string; permissions: { code: string; description: string }[] }[]; customRoles: boolean; history: { role: string; action: string; added: string[]; removed: string[]; by: string; at: string }[] }
interface Preview { home: string; nav: { key: string; label: string; href: string; zone: string }[]; permissions: string[] }
interface Staff { userId: string; name: string; email: string }

const when = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** Role editor: what each role may do (by module), custom roles, preview as the role, who has it. */
export default async function Roles({ searchParams }: { searchParams: Promise<{ role?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('admin', '/admin/roles');
  const sp = await searchParams;
  const { accessToken: token } = (await getSession())!;
  const ed = await api<Editor>('/api/entitlement/v1/role-editor', { token });
  const role = ed.roles.find((r) => r.code === sp.role) ?? ed.roles.find((r) => r.code === 'NURSE') ?? ed.roles[0];
  const manage = can(caps, 'role:manage:tenant') && ed.customRoles;
  const [preview, staff] = await Promise.all([
    api<Preview>(`/api/entitlement/v1/roles/${role.code}/preview`, { token }).catch(() => null),
    can(caps, 'staff:read:tenant') ? api<Staff[]>('/api/iam/v1/staff', { token }).catch(() => [] as Staff[]) : Promise.resolve([] as Staff[]),
  ]);
  const byUser = await api<Record<string, string[]>>('/api/entitlement/v1/user-roles', { token }).catch(() => ({} as Record<string, string[]>));
  const rolesOf = staff.map((s) => ({ ...s, roles: byUser[s.userId] ?? [] }));
  const withRole = rolesOf.filter((s) => s.roles.includes(role.code));
  const has = new Set(role.permissions);
  const zones = [...new Set(preview?.nav.map((n) => n.zone) ?? [])];
  return (
    <ZoneFrame zone="admin" path="/admin/roles" zones={ZONES}>
      <PageHeader title="Roles" subtitle="What each role may do. Changes apply at once to everyone with the role." />
      <Flash ok={sp.ok} error={sp.error} />
      {!ed.customRoles ? <Upsell feature="core.custom_roles" /> : null}
      <div className="mc-chips" aria-label="Roles">
        {ed.roles.map((r) => <a key={r.code} className={`mc-chip${r.code === role.code ? ' active' : ''}`} href={`/admin/roles?role=${r.code}`}>{r.name}{r.isSystem ? '' : ' ★'}{r.users ? ` (${r.users})` : ''}</a>)}
      </div>

      <Card title={role.name}>
        <p style={{ marginTop: 0 }}>
          <code>{role.code}</code> {role.isSystem ? <Badge>{role.customized ? 'system role, changed here' : 'system role'}</Badge> : <Badge tone="success">custom{role.basedOn ? ` (from ${role.basedOn})` : ''}</Badge>}
          {role.grantsAll ? <span className="mc-meta"> · everything in your plan</span> : <span className="mc-meta"> · {role.permissions.length} permissions</span>}
          {role.description ? <span className="mc-meta"> · {role.description}</span> : null}
        </p>
        {role.grantsAll || role.code === 'PATIENT' ? <p className="mc-meta">This role cannot be edited.</p> : (
          <form action={saveRole} aria-label="Permissions">
            <input type="hidden" name="role" value={role.code} />
            <fieldset disabled={!manage} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
              {ed.catalogue.map((m) => (
                <fieldset key={m.module} style={{ border: '1px solid var(--line, #e5e7eb)', borderRadius: 8, padding: '8px 12px' }}>
                  <legend><strong>{m.name}</strong></legend>
                  <div style={{ display: 'grid', gap: 4, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
                    {m.permissions.map((p) => (
                      <label key={p.code} className="mc-check"><input type="checkbox" name="permission" value={p.code} defaultChecked={has.has(p.code)} aria-label={p.description} /> <span>{p.description} <span className="mc-meta">{p.code}</span></span></label>
                    ))}
                  </div>
                </fieldset>
              ))}
              {manage ? <div><Button>Save permissions</Button></div> : null}
            </fieldset>
          </form>
        )}
        {manage && !role.isSystem ? <form action={deleteRole} style={{ marginTop: 12 }}><input type="hidden" name="role" value={role.code} /><Button variant="danger">Delete role</Button></form> : null}
      </Card>

      {preview ? (
        <Card title={`Preview: someone with only "${role.name}"`}>
          <p style={{ marginTop: 0 }}>Opens at <code>{preview.home}</code>; {preview.permissions.length} permissions.</p>
          {zones.length ? zones.map((z) => <p key={z} style={{ margin: '4px 0' }}><strong>{z}</strong>: {preview.nav.filter((n) => n.zone === z).map((n) => n.label).join(' · ')}</p>) : <p className="mc-meta">No screens: this role cannot open any part of MediCare.</p>}
        </Card>
      ) : null}

      {staff.length && !role.grantsAll && role.code !== 'PATIENT' ? (
        <Card title="Who has it">
          <Table rows={withRole} empty="Nobody yet." columns={[
            { header: 'Name', cell: (s) => <>{s.name} <span className="mc-meta">{s.email}</span></> },
            { header: '', cell: (s) => (can(caps, 'role:assign:tenant') ? <form action={takeRole}><input type="hidden" name="role" value={role.code} /><input type="hidden" name="userId" value={s.userId} /><button className="mc-btn mc-btn-ghost">Remove</button></form> : null) },
          ]} />
          {can(caps, 'role:assign:tenant') ? (
            <form action={giveRole} className="mc-inline" aria-label="Give role" style={{ marginTop: 12 }}>
              <input type="hidden" name="role" value={role.code} />
              <select name="userId" required aria-label="Staff member" defaultValue="">
                <option value="" disabled>Choose a staff member…</option>
                {rolesOf.filter((s) => !s.roles.includes(role.code)).map((s) => <option key={s.userId} value={s.userId}>{s.name} ({s.email})</option>)}
              </select>
              <button className="mc-btn mc-btn-ghost">Give {role.name}</button>
            </form>
          ) : null}
        </Card>
      ) : null}

      {manage ? (
        <Card title="New role">
          <form action={createRole} className="mc-form" aria-label="New role">
            <Field label="Name" name="name" required placeholder="Senior nurse" />
            <Field label="Code" name="code" required placeholder="SENIOR_NURSE" pattern="[A-Za-z_]{3,40}" hint="CAPITALS_AND_UNDERSCORES" />
            <label className="mc-field"><span>Start from</span>
              <select name="copyFrom" defaultValue="NURSE"><option value="">Nothing</option>{ed.roles.filter((r) => r.editable && !r.grantsAll).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select>
            </label>
            <Field label="What it is for" name="description" placeholder="Nurses who also manage the queue" />
            <Button>Create role</Button>
          </form>
        </Card>
      ) : null}

      <Card title="Changes">
        <Table rows={ed.history.slice(0, 20)} empty="No changes yet." columns={[
          { header: 'When', cell: (h) => when(h.at) },
          { header: 'Role', cell: (h) => h.role },
          { header: 'Change', cell: (h) => <>{h.action.toLowerCase()}{h.added.length ? <div className="mc-meta">+ {h.added.join(', ')}</div> : null}{h.removed.length ? <div className="mc-meta">− {h.removed.join(', ')}</div> : null}</> },
          { header: 'By', cell: (h) => h.by },
        ]} />
      </Card>
    </ZoneFrame>
  );
}
