import { Injectable } from '@nestjs/common';
import { DomainError } from '@mc/nest-common';
import { type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { EntitlementsService } from './entitlements.service.js';

/** Roles the role editor never changes: the owner's (everything) and the patients' (product-defined). */
const LOCKED = new Set(['TENANT_ADMIN', 'PATIENT']);

/**
 * What a hospital configures itself (docs/PRODUCT-MODULES-AND-PLANS.md §7): settings within the plan's bounds, and
 * roles (custom roles cloned from a system role; system roles edited copy-on-write: template updates stop applying).
 */
@Injectable()
export class ConfigService {
  constructor(private readonly db: TenantDbRouter, private readonly ent: EntitlementsService) {}

  // ---------- settings ----------

  /** Every setting of the hospital's active modules: manifest range, plan bounds, stored and effective value. */
  async settings(c?: Queryable) {
    const pool = c ?? (await this.db.current());
    const active = await this.ent.activeModules(pool);
    const [{ rows: stored }, { rows: bounds }] = await Promise.all([
      pool.query('SELECT setting_key, value, updated_by, updated_at FROM tenant_settings'),
      pool.query('SELECT setting_key, bounds FROM tenant_setting_bounds'),
    ]);
    const val = new Map(stored.map((r) => [r.setting_key, r]));
    const bnd = new Map(bounds.map((r) => [r.setting_key, r.bounds as { min: number | null; max: number | null; allowed: string[] | null }]));
    const out = [];
    for (const k of active) {
      const m = this.ent.catalog.modules.get(k)!;
      for (const s of m.settings) {
        const b = s.planBounded ? bnd.get(s.key) : undefined;
        const min = Math.max(s.min ?? -Infinity, b?.min ?? -Infinity);
        const max = Math.min(s.max ?? Infinity, b?.max ?? Infinity);
        const allowed = b?.allowed ?? s.values ?? null;
        const saved = val.get(s.key);
        const value = saved ? saved.value : s.default;
        // a tighter plan clamps a saved value (the admin sees it was adjusted)
        let effective = value;
        if (s.type === 'int' && typeof value === 'number') effective = Math.min(max, Math.max(min, value));
        if (s.type === 'enum' && allowed && !allowed.includes(String(value))) effective = allowed.includes(String(s.default)) ? s.default : allowed[0];
        out.push({
          key: s.key, module: m.key, moduleName: m.name, name: s.name, type: s.type, default: s.default,
          min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null, allowed,
          planBounded: s.planBounded, value, effective, adjusted: effective !== value,
          updatedBy: saved?.updated_by ?? null, updatedAt: saved?.updated_at ?? null,
        });
      }
    }
    return out;
  }

  /** key → effective value (services read these through the SDK). */
  async effective() {
    return Object.fromEntries((await this.settings()).map((s) => [s.key, s.effective]));
  }

  async saveSetting(key: string, value: unknown, by: string) {
    return this.db.tx(async (c) => {
      const s = (await this.settings(c)).find((x) => x.key === key);
      if (!s) throw new DomainError(404, 'UNKNOWN_SETTING', `no setting ${key} for this hospital's modules`);
      if (s.type === 'int') {
        if (typeof value !== 'number' || !Number.isInteger(value)) throw new DomainError(422, 'BAD_VALUE', `${s.name}: a whole number`);
        if ((s.min != null && value < s.min) || (s.max != null && value > s.max)) throw new DomainError(422, 'OUT_OF_BOUNDS', `${s.name}: between ${s.min ?? '…'} and ${s.max ?? '…'}${s.planBounded ? ' on your plan' : ''}`, { min: s.min, max: s.max });
      } else if (s.type === 'enum') {
        if (!s.allowed?.includes(String(value))) throw new DomainError(422, 'OUT_OF_BOUNDS', `${s.name}: one of ${s.allowed?.join(', ')}`);
      } else if (typeof value !== 'boolean') throw new DomainError(422, 'BAD_VALUE', `${s.name}: true or false`);
      await c.query(`INSERT INTO tenant_settings (setting_key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (setting_key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`, [key, JSON.stringify(value), by]);
      await this.ent.changed(c, null, `setting ${key} = ${JSON.stringify(value)}`);
      return (await this.settings(c)).find((x) => x.key === key);
    });
  }

  // ---------- roles ----------

  /** Permissions the role editor offers: those of the hospital's active modules, grouped by module. */
  async catalogue() {
    const active = await this.ent.activeModules(await this.db.current());
    return active.map((k) => this.ent.catalog.modules.get(k)!).filter((m) => m.permissions.length).map((m) => ({ module: m.key, name: m.name, permissions: m.permissions }));
  }

  async roles() {
    const { rows } = await this.db.query(`SELECT r.code, r.name, r.is_system, r.grants_all, r.customized, r.based_on, r.description, r.home, r.updated_by, r.updated_at,
        coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') permissions,
        (SELECT count(DISTINCT ur.user_id)::int FROM user_roles ur WHERE ur.role_id = r.id) users
      FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.is_system DESC, r.code`);
    return rows.map((r) => ({ code: r.code, name: r.name, isSystem: r.is_system, grantsAll: r.grants_all, customized: r.customized, basedOn: r.based_on, description: r.description, home: r.home,
      permissions: r.permissions, users: r.users, editable: !LOCKED.has(r.code), updatedBy: r.updated_by, updatedAt: r.updated_at }));
  }

  async customRolesAllowed() {
    const { rows: [f] } = await this.db.query(`SELECT enabled FROM tenant_features WHERE feature_key = 'core.custom_roles'`);
    return f ? f.enabled : true;
  }

  private async assertCustomRoles() {
    if (!(await this.customRolesAllowed())) throw new DomainError(403, 'FEATURE_NOT_IN_PLAN', 'custom roles are not in this hospital\'s plan', { feature: 'core.custom_roles', upgradeUrl: '/account/plan' });
  }

  private async validPermissions(perms: string[]) {
    const offered = new Set((await this.catalogue()).flatMap((m) => m.permissions.map((p) => p.code)));
    const bad = perms.filter((p) => !offered.has(p));
    if (bad.length) throw new DomainError(422, 'UNKNOWN_PERMISSION', `not available in this hospital: ${bad.join(', ')}`, { permissions: bad });
  }

  /** A new role, empty or copied from another (its permissions and home page). */
  async createRole(input: { code: string; name: string; description: string | null; copyFrom: string | null }, by: string, actorId: string) {
    await this.assertCustomRoles();
    await this.db.tx(async (c) => {
      const { rows: [dup] } = await c.query('SELECT 1 FROM roles WHERE code = $1', [input.code]);
      if (dup) throw new DomainError(409, 'ROLE_EXISTS', `a role ${input.code} already exists`);
      let perms: string[] = [];
      let home = '/';
      if (input.copyFrom) {
        const { rows: [src] } = await c.query(`SELECT r.id, r.home, r.grants_all, coalesce(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') perms FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.code = $1 GROUP BY r.id`, [input.copyFrom]);
        if (!src || LOCKED.has(input.copyFrom)) throw new DomainError(422, 'BAD_BASE_ROLE', `cannot copy ${input.copyFrom}`);
        perms = src.perms;
        home = src.home;
        const mine = await this.ent.grantsOf(c, actorId);
        if (!mine.grantsAll && (src.grants_all || (perms as string[]).some((p) => !mine.perms.has(p)))) throw new DomainError(403, 'ROLE_ESCALATION', `you can only copy a role whose permissions you have yourself`);
      }
      const id = randomUUID();
      await c.query(`INSERT INTO roles (id, code, name, is_system, grants_all, customized, home, based_on, description, updated_by, updated_at) VALUES ($1,$2,$3,false,false,true,$4,$5,$6,$7,now())`, [id, input.code, input.name, home, input.copyFrom, input.description, by]);
      for (const p of perms) await c.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2)', [id, p]);
      await c.query(`INSERT INTO role_changes (role_code, action, added, by_user) VALUES ($1,'CREATED',$2,$3)`, [input.code, perms, by]);
      await this.ent.changed(c, null, `role ${input.code} created`);
    });
    // read back after the commit (roles() uses its own connection)
    return (await this.roles()).find((r) => r.code === input.code);
  }

  /** Set a role's permissions. A system role becomes "customized" (template updates no longer apply to it). */
  async setPermissions(code: string, permissions: string[], by: string, actorId: string, opts: { name?: string; description?: string | null } = {}) {
    if (LOCKED.has(code)) throw new DomainError(422, 'ROLE_LOCKED', `${code} cannot be edited`);
    await this.assertCustomRoles();
    await this.validPermissions(permissions);
    const change = await this.db.tx(async (c) => {
      const { rows: [locked] } = await c.query('SELECT id FROM roles WHERE code = $1 FOR UPDATE', [code]);
      if (!locked) throw new DomainError(404, 'NOT_FOUND', 'role not found');
      const { rows: perms } = await c.query('SELECT permission_code FROM role_permissions WHERE role_id = $1', [locked.id]);
      const role = { id: locked.id as string, perms: perms.map((p) => p.permission_code as string) };
      const want = new Set(permissions);
      const added = permissions.filter((p) => !role.perms.includes(p));
      const removed = (role.perms as string[]).filter((p) => !want.has(p));
      // a role editor can only add what they hold themselves (no self-promotion; review B-3); removing is always fine
      const mine = await this.ent.grantsOf(c, actorId);
      const beyond = mine.grantsAll ? [] : added.filter((p) => !mine.perms.has(p));
      if (beyond.length) throw new DomainError(403, 'ROLE_ESCALATION', `you can only give permissions you have yourself (missing: ${beyond.slice(0, 5).join(', ')})`, { missing: beyond });
      await c.query('DELETE FROM role_permissions WHERE role_id = $1', [role.id]);
      for (const p of want) await c.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2)', [role.id, p]);
      await c.query(`UPDATE roles SET customized = true, version = version + 1, updated_by = $2, updated_at = now(), name = coalesce($3, name), description = CASE WHEN $5 THEN $4 ELSE description END WHERE id = $1`,
        [role.id, by, opts.name ?? null, opts.description ?? null, opts.description !== undefined]);
      if (added.length || removed.length) await c.query(`INSERT INTO role_changes (role_code, action, added, removed, by_user) VALUES ($1,'PERMISSIONS',$2,$3,$4)`, [code, added, removed, by]);
      await this.ent.changed(c, null, `role ${code} permissions`);
      return { added, removed };
    });
    return { role: (await this.roles()).find((r) => r.code === code), ...change };
  }

  /** Delete a custom role nobody holds. */
  async deleteRole(code: string, by: string) {
    return this.db.tx(async (c) => {
      const { rows: [r] } = await c.query('SELECT id, is_system FROM roles WHERE code = $1 FOR UPDATE', [code]);
      if (!r) throw new DomainError(404, 'NOT_FOUND', 'role not found');
      if (r.is_system) throw new DomainError(422, 'ROLE_LOCKED', 'system roles cannot be deleted (edit a copy instead)');
      const { rows: [u] } = await c.query('SELECT count(*)::int n FROM user_roles WHERE role_id = $1', [r.id]);
      if (u.n) throw new DomainError(409, 'ROLE_IN_USE', `${u.n} staff member(s) have this role: remove it from them first`);
      await c.query('DELETE FROM roles WHERE id = $1', [r.id]);
      await c.query(`INSERT INTO role_changes (role_code, action, by_user) VALUES ($1,'DELETED',$2)`, [code, by]);
      await this.ent.changed(c, null, `role ${code} deleted`);
    });
  }

  async history(code?: string) {
    const { rows } = await this.db.query('SELECT role_code, action, added, removed, by_user, at FROM role_changes WHERE ($1::text IS NULL OR role_code = $1) ORDER BY id DESC LIMIT 100', [code ?? null]);
    return rows.map((r) => ({ role: r.role_code, action: r.action, added: r.added, removed: r.removed, by: r.by_user, at: r.at }));
  }

  /** What someone with only this role would see and be allowed to do. */
  async preview(code: string) {
    const { rows: [r] } = await this.db.query('SELECT 1 FROM roles WHERE code = $1', [code]);
    if (!r) throw new DomainError(404, 'NOT_FOUND', 'role not found');
    const caps = await this.ent.capabilities({ id: randomUUID(), kind: code === 'PATIENT' ? 'patient' : 'staff' }, { previewRole: code });
    return { role: code, home: caps.home, nav: caps.nav, permissions: caps.permissions, tenant: TenantContext.require().slug };
  }

  /** Guardrail: the hospital must keep at least one owner; nobody removes their own owner role. */
  async assertNotLastOwner(c: Queryable, userId: string, roleCode: string, actorId: string) {
    if (roleCode !== 'TENANT_ADMIN') return;
    if (userId === actorId) throw new DomainError(422, 'OWN_ADMIN_ROLE', 'you cannot remove your own hospital admin role');
    const { rows: [n] } = await c.query(`SELECT count(DISTINCT ur.user_id)::int n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'TENANT_ADMIN' AND ur.user_id <> $1`, [userId]);
    if (!n.n) throw new DomainError(422, 'LAST_ADMIN', 'the hospital must keep at least one hospital admin');
  }
}
