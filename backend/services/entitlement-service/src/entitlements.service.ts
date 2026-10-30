import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type ActorKind, type Capabilities, type ContractChanged, type SubscriptionStatusChanged, type EntitlementsChanged, EventTypes, type FeatureState, type ModuleStateChanged, type NavItem, Topics } from '@mc/contracts';
import { CONTROL_DB, DomainError, PLACEMENTS, REDIS, type Redis, retryInBackground } from '@mc/nest-common';
import { addToOutbox, envelope, type PlacementSource, type Queryable, TenantContext, TenantDbRouter, withTx } from '@mc/tenancy';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { type Catalog, isReadPermission, loadCatalog, templateGrants } from '@mc/entitlements-sdk/catalog';
import { scopesOf } from './branch-scopes.js';

const CAP_TTL_S = 300;
/** subscription states in which nothing new can be done (records stay readable) */
const BLOCKING = ['SUSPENDED', 'CANCELLED', 'EXPIRED'];

@Injectable()
export class EntitlementsService implements OnModuleInit {
  private readonly log = new Logger('Entitlements');
  catalog!: Catalog;
  /** part of the capabilities cache key: a manifest change (deploy) invalidates every cached answer */
  private catalogHash = '';

  constructor(
    @Inject(CONTROL_DB) private readonly control: pg.Pool,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly db: TenantDbRouter,
  ) {}

  async onModuleInit() {
    this.catalog = loadCatalog();
    this.catalogHash = createHash('sha256').update(JSON.stringify([...this.catalog.modules.values(), this.catalog.roles])).digest('hex').slice(0, 12);
    await this.syncRegistry();
    // new manifest grants reach existing hospitals' (uncustomized) system roles; tenant-service may still be starting
    retryInBackground('RoleSync', async () => {
      for (const t of await this.placements.list()) {
        if (t.status !== 'ACTIVE') continue;
        // new version in the same transaction: cached capabilities are dropped so the new grants apply now
        await TenantContext.run(t, () => this.db.tx(async (c) => { await this.syncSystemRoles(c); await c.query('UPDATE caps_version SET version = version + 1'); }));
      }
      this.log.log('system roles synced for every hospital');
    });
  }

  /** Mirror manifests into the control-plane registry (read by the platform console later). */
  private async syncRegistry() {
    await withTx(this.control, async (c) => {
      for (const m of this.catalog.modules.values()) {
        await c.query(`INSERT INTO modules (key, name, version, manifest) VALUES ($1,$2,$3,$4)
          ON CONFLICT (key) DO UPDATE SET name = $2, version = $3, manifest = $4, synced_at = now()`, [m.key, m.name, m.version, m]);
        for (const p of m.permissions) await c.query(`INSERT INTO permissions (code, module_key, description) VALUES ($1,$2,$3)
          ON CONFLICT (code) DO UPDATE SET module_key = $2, description = $3`, [p.code, m.key, p.description]);
        for (const f of m.features) await c.query(`INSERT INTO features (key, module_key, type, unit) VALUES ($1,$2,$3,$4)
          ON CONFLICT (key) DO UPDATE SET module_key = $2, type = $3, unit = $4`, [f.key, m.key, f.type, f.unit ?? null]);
      }
    });
    this.log.log(`registry: ${this.catalog.modules.size} modules, ${this.catalog.permissionModule.size} permissions`);
  }

  /**
   * Create missing system roles and keep roles the hospital hasn't customized equal to the template: new grants are
   * added and grants the template dropped are removed (review B-4 trimmed some defaults).
   */
  async syncSystemRoles(c: Queryable) {
    const allModules = [...this.catalog.modules.keys()];
    for (const r of this.catalog.roles) {
      const { rows } = await c.query(
        `INSERT INTO roles (id, code, name, is_system, grants_all, home) VALUES ($1,$2,$3,true,$4,$5)
         ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id, customized`,
        [randomUUID(), r.code, r.name, r.grantsAll, r.home],
      );
      if (rows[0].customized) continue;
      const grants = templateGrants(this.catalog, r.code, allModules);
      for (const p of grants) {
        await c.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rows[0].id, p]);
      }
      await c.query('DELETE FROM role_permissions WHERE role_id = $1 AND NOT (permission_code = ANY($2))', [rows[0].id, grants]);
    }
  }

  /** tenant.provisioned: role templates. Modules come from the hospital's contract (subscription.contract_changed). */
  async onTenantProvisioned(c: Queryable) {
    await this.syncSystemRoles(c);
  }

  /**
   * subscription.contract_changed: store the plan, features and setting bounds, and start switching modules on/off
   * (docs/PRODUCT-MODULES-AND-PLANS.md §8). Added modules → ACTIVATING, removed ones → DISABLING; ModuleLifecycleJob
   * runs the services' hooks and finishes the move (ACTIVE / READ_ONLY). Data is never deleted.
   */
  async applyContract(c: Queryable, d: ContractChanged) {
    const { rows: [cur] } = await c.query('SELECT seq FROM tenant_plan FOR UPDATE');
    if (cur && cur.seq >= d.seq) return { applied: false };
    await c.query(`INSERT INTO tenant_plan (id, contract_id, seq, plan_code, plan_name, plan_version, edition, addons, applied_at) VALUES (true,$1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT (id) DO UPDATE SET contract_id = $1, seq = $2, plan_code = $3, plan_name = $4, plan_version = $5, edition = $6, addons = $7, applied_at = now()`,
      [d.contractId, d.seq, d.plan.code, d.plan.name, d.plan.version, d.plan.edition, JSON.stringify(d.addons)]);
    await c.query('DELETE FROM tenant_features');
    for (const [k, f] of Object.entries(d.features)) await c.query('INSERT INTO tenant_features (feature_key, enabled, limit_value, overage) VALUES ($1,$2,$3,$4)', [k, f.enabled, f.limit, f.overage ?? null]);
    await c.query('DELETE FROM tenant_setting_bounds');
    for (const [k, b] of Object.entries(d.settingBounds)) await c.query('INSERT INTO tenant_setting_bounds (setting_key, bounds) VALUES ($1,$2)', [k, JSON.stringify(b)]);

    const { rows } = await c.query('SELECT module_key, state FROM tenant_modules');
    const state = new Map<string, string>(rows.map((r) => [r.module_key, r.state]));
    const wanted = new Map(d.modules.filter((m) => this.catalog.modules.has(m.key)).map((m) => [m.key, m.source]));
    const added: string[] = [];
    const removed: string[] = [];
    for (const [key, source] of wanted) {
      const s = state.get(key);
      if (s === 'ACTIVE' || s === 'ACTIVATING') {
        await c.query('UPDATE tenant_modules SET source = $2 WHERE module_key = $1', [key, source]);
        continue;
      }
      added.push(key);
      await c.query(`INSERT INTO tenant_modules (module_key, state, source, since, attempts, next_attempt_at, last_error) VALUES ($1,'ACTIVATING',$2,now(),0,now(),NULL)
        ON CONFLICT (module_key) DO UPDATE SET state = 'ACTIVATING', source = $2, since = now(), attempts = 0, next_attempt_at = now(), last_error = NULL`, [key, source]);
    }
    for (const [key, s] of state) {
      if (wanted.has(key) || this.catalog.modules.get(key)?.alwaysOn || (s !== 'ACTIVE' && s !== 'ACTIVATING')) continue;
      removed.push(key);
      await c.query(`UPDATE tenant_modules SET state = 'DISABLING', since = now(), attempts = 0, next_attempt_at = now(), last_error = NULL WHERE module_key = $1`, [key]);
    }
    await this.changed(c, null, `plan ${d.plan.code} v${d.plan.version}: ${d.reason}`);
    if (added.length || removed.length) this.log.log(`${TenantContext.require().slug}: plan ${d.plan.code} → switching on [${added.join(', ')}], off [${removed.join(', ')}]`);
    return { applied: true, added, removed };
  }

  /** subscription.status_changed: SUSPENDED/CANCELLED/EXPIRED make every module but core read-only (no hooks: instant both ways). */
  async applyBillingStatus(c: Queryable, d: SubscriptionStatusChanged) {
    const { rows: [cur] } = await c.query('SELECT seq FROM tenant_billing FOR UPDATE');
    if (cur && cur.seq >= d.seq) return;
    await c.query(`INSERT INTO tenant_billing (id, status, seq, trial_ends_at, grace_ends_at, period_end, updated_at) VALUES (true,$1,$2,$3,$4,$5,now())
      ON CONFLICT (id) DO UPDATE SET status = $1, seq = $2, trial_ends_at = $3, grace_ends_at = $4, period_end = $5, updated_at = now()`, [d.status, d.seq, d.trialEndsAt, d.graceEndsAt, d.periodEnd]);
    await this.changed(c, null, `subscription ${d.status}`);
  }

  async billing(c: Queryable): Promise<{ status: string; trialEndsAt: string | null; graceEndsAt: string | null }> {
    const { rows: [b] } = await c.query('SELECT status, trial_ends_at, grace_ends_at FROM tenant_billing');
    return { status: b?.status ?? 'NONE', trialEndsAt: b?.trial_ends_at?.toISOString?.() ?? null, graceEndsAt: b?.grace_ends_at?.toISOString?.() ?? null };
  }

  /** Effective features (limits and overage rules), for metering without an actor. */
  async tenantFeatures(c: Queryable) {
    const { rows } = await c.query('SELECT feature_key, enabled, limit_value, overage FROM tenant_features');
    return {
      features: Object.fromEntries(rows.map((r) => [r.feature_key, { enabled: r.enabled, limit: r.limit_value == null ? null : Number(r.limit_value), overage: r.overage ?? null }])),
      billingStatus: (await this.billing(c)).status,
    };
  }

  /** Staff whose roles give a permission (e.g. the account owners who hear about billing). grants_all roles count. */
  /** Who holds a permission (at a branch: grants for that branch or for every branch). */
  async usersWithPermission(c: Queryable, permission: string, branchId: string | null = null): Promise<string[]> {
    const { rows } = await c.query(`SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE (ur.valid_until IS NULL OR ur.valid_until > now()) AND (r.grants_all OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_code = $1))
        AND ($2::uuid IS NULL OR ur.branch_id IS NULL OR ur.branch_id = $2)`, [permission, branchId]);
    return rows.map((r) => r.user_id);
  }

  /** Modules waiting for their lifecycle hooks (due now). */
  async pendingModules(c: Queryable): Promise<{ module_key: string; state: 'ACTIVATING' | 'DISABLING'; attempts: number }[]> {
    const { rows } = await c.query(`SELECT module_key, state, attempts FROM tenant_modules WHERE state IN ('ACTIVATING','DISABLING') AND coalesce(next_attempt_at, now()) <= now() ORDER BY since`);
    return rows;
  }

  /** Hooks done: ACTIVATING → ACTIVE, DISABLING → READ_ONLY (only if nothing changed the module meanwhile). */
  async finishModule(c: Queryable, key: string, from: 'ACTIVATING' | 'DISABLING') {
    const to = from === 'ACTIVATING' ? 'ACTIVE' : 'READ_ONLY';
    const { rowCount } = await c.query(`UPDATE tenant_modules SET state = $3, since = now(), attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE module_key = $1 AND state = $2`, [key, from, to]);
    if (!rowCount) return;
    const data: ModuleStateChanged = { module: key, state: to };
    await addToOutbox(c, Topics.entitlement, TenantContext.require().id, envelope(EventTypes.moduleStateChanged, data, { tenantId: TenantContext.require().id }));
    await this.changed(c, null, `module ${key} ${to}`);
  }

  /** A hook failed: retry with backoff (2 s, 4 s … capped at 5 min); the module stays ACTIVATING/DISABLING meanwhile. */
  async retryModule(c: Queryable, key: string, from: string, attempts: number, error: string) {
    const delay = Math.min(2 ** (attempts + 1), 300);
    await c.query(`UPDATE tenant_modules SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $3), last_error = $4 WHERE module_key = $1 AND state = $2`, [key, from, delay, error.slice(0, 500)]);
  }

  async rememberUser(c: Queryable, userId: string, email: string) {
    await c.query('INSERT INTO known_users (user_id, email) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email', [userId, email]);
  }

  async assertKnownUser(c: Queryable, userId: string) {
    const { rowCount } = await c.query('SELECT 1 FROM known_users WHERE user_id = $1', [userId]);
    if (!rowCount) throw new DomainError(404, 'NOT_FOUND', 'user not found');
  }

  /**
   * No privilege escalation (docs/ROLE-FLOWS-AND-GAPS.md B-3): a staff member may give (by invite or assignment) only
   * roles whose permissions they hold themselves, and only a hospital admin may make someone a hospital admin.
   * Patients' role is never given to staff. Unknown roles are refused here, before any login is created.
   * Someone who works at some branches only gives roles at those branches (review B-1).
   */
  async assertCanGrant(c: Queryable, actorId: string, roleCodes: string[], branchId: string | null = null) {
    const mine = await this.grantsOf(c, actorId);
    if (mine.branches && (!branchId || !mine.branches.includes(branchId))) {
      throw new DomainError(403, 'OUTSIDE_BRANCH', 'you can give roles only at the branches you work at: pick one of them');
    }
    for (const code of roleCodes) {
      const { rows: [r] } = await c.query(`SELECT r.code, r.grants_all, coalesce(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') perms
        FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.code = $1 GROUP BY r.id`, [code]);
      if (!r) throw new DomainError(422, 'UNKNOWN_ROLE', `role ${code} does not exist`);
      if (code === 'PATIENT') throw new DomainError(422, 'PATIENT_ROLE', 'the patient role is not given to staff');
      if (mine.grantsAll) continue;
      if (r.grants_all) throw new DomainError(403, 'ROLE_ESCALATION', 'only a hospital admin can make someone a hospital admin');
      const missing = (r.perms as string[]).filter((p) => !mine.perms.has(p));
      if (missing.length) throw new DomainError(403, 'ROLE_ESCALATION', `you can only give roles whose permissions you have yourself (missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''})`, { missing });
    }
  }

  /**
   * Permissions a staff member holds through their roles (ignoring plans: the escalation rule is about roles), and the
   * branches they work at (null = a grant without a branch, so every branch).
   */
  async grantsOf(c: Queryable, userId: string) {
    const { rows } = await c.query(`SELECT bool_or(r.grants_all) AS all, coalesce(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') perms,
        bool_or(ur.branch_id IS NULL) AS wide, coalesce(array_agg(DISTINCT ur.branch_id) FILTER (WHERE ur.branch_id IS NOT NULL), '{}') branches
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE ur.user_id = $1 AND (ur.valid_until IS NULL OR ur.valid_until > now())`, [userId]);
    const r = rows[0];
    return { grantsAll: !!r?.all, perms: new Set<string>(r?.perms ?? []), branches: r?.wide === false ? (r.branches as string[]) : null };
  }

  /** The role grants a staff member has: { roleCode, branchId }. */
  async grantsList(c: Queryable, userId: string): Promise<{ roleCode: string; branchId: string | null }[]> {
    const { rows } = await c.query('SELECT r.code, ur.branch_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code', [userId]);
    return rows.map((r) => ({ roleCode: r.code, branchId: r.branch_id }));
  }

  /**
   * May `actorId` manage this person's account (deactivate, reset sign-in, resend the invite; review B-2)? Only if they
   * could have given every role the person has, where they have it: nobody locks out someone with more power.
   */
  async assertCanManage(c: Queryable, actorId: string, userId: string) {
    if (actorId === userId) throw new DomainError(422, 'OWN_ACCOUNT', 'you cannot do this to your own account');
    for (const g of await this.grantsList(c, userId)) await this.assertCanGrant(c, actorId, [g.roleCode], g.branchId);
  }

  /** Offboarding: every role goes (the hospital keeps at least one hospital admin). Returns what was removed. */
  async revokeAll(c: Queryable, actorId: string, userId: string) {
    await this.assertCanManage(c, actorId, userId);
    const grants = await this.grantsList(c, userId);
    if (grants.some((g) => g.roleCode === 'TENANT_ADMIN')) {
      const { rows: [n] } = await c.query(`SELECT count(DISTINCT ur.user_id)::int n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'TENANT_ADMIN' AND ur.user_id <> $1`, [userId]);
      if (!n.n) throw new DomainError(422, 'LAST_ADMIN', 'the hospital must keep at least one hospital admin');
    }
    await c.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await this.changed(c, userId, 'staff deactivated');
    return { removed: grants };
  }

  async assignRoles(c: Queryable, userId: string, roleCodes: string[], branchId: string | null = null) {
    await this.assertKnownUser(c, userId);
    for (const code of roleCodes) {
      const { rows } = await c.query('SELECT id FROM roles WHERE code = $1', [code]);
      if (!rows[0]) throw new DomainError(422, 'UNKNOWN_ROLE', `role ${code} does not exist`);
      await c.query(`INSERT INTO user_roles (id, user_id, role_id, branch_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [randomUUID(), userId, rows[0].id, branchId]);
    }
    await this.changed(c, userId, 'roles assigned');
  }

  async removeRole(c: Queryable, userId: string, roleCode: string) {
    await this.assertKnownUser(c, userId);
    const { rowCount } = await c.query('DELETE FROM user_roles ur USING roles r WHERE ur.role_id = r.id AND ur.user_id = $1 AND r.code = $2', [userId, roleCode]);
    if (!rowCount) throw new DomainError(404, 'NOT_FOUND', 'role assignment not found');
    await this.changed(c, userId, 'role removed');
  }

  /**
   * Module states for this hospital; always-on modules count as ACTIVE even before the first contract arrives. While
   * the subscription is SUSPENDED / CANCELLED / EXPIRED every other module reads as READ_ONLY (records stay viewable).
   */
  async moduleStates(c: Queryable): Promise<Map<string, string>> {
    const { rows } = await c.query('SELECT module_key, state FROM tenant_modules');
    const out = new Map<string, string>(rows.filter((r) => this.catalog.modules.has(r.module_key)).map((r) => [r.module_key, r.state]));
    if (BLOCKING.includes((await this.billing(c)).status)) for (const [k, s] of out) if (s === 'ACTIVE' || s === 'ACTIVATING') out.set(k, 'READ_ONLY');
    for (const m of this.catalog.modules.values()) if (m.alwaysOn) out.set(m.key, 'ACTIVE');
    return out;
  }

  async activeModules(c: Queryable): Promise<string[]> {
    return [...(await this.moduleStates(c))].filter(([, s]) => s === 'ACTIVE').map(([k]) => k);
  }

  /** For the SDK guard: in full use, and readable only (READ_ONLY, or on its way there). */
  async tenantModules(c: Queryable) {
    const states = [...(await this.moduleStates(c))];
    return { modules: states.filter(([, s]) => s === 'ACTIVE').map(([k]) => k).sort(), readOnly: states.filter(([, s]) => s === 'READ_ONLY' || s === 'DISABLING').map(([k]) => k).sort() };
  }

  /**
   * Bump the tenant's capabilities version (part of the cache key) IN the change's transaction, and tell every service
   * to drop cached capabilities. (A counter outside the transaction could be read before the change commits, and the
   * old answer would then be cached under the new version.)
   */
  async changed(c: Queryable, userId: string | null, reason: string) {
    const tenantId = TenantContext.require().id;
    const version = Number((await c.query('UPDATE caps_version SET version = version + 1 RETURNING version')).rows[0].version);
    const data: EntitlementsChanged = { userId, reason, version };
    await addToOutbox(c, Topics.entitlement, tenantId, envelope(EventTypes.entitlementsChanged, data, { tenantId }));
  }

  /** Modules ordered so dependencies come first (core, then directory, appointments…): stable nav order. */
  private dependencyOrder(keys: string[]): string[] {
    const out: string[] = [];
    const visit = (k: string) => {
      if (out.includes(k) || !keys.includes(k)) return;
      for (const d of this.catalog.modules.get(k)?.dependsOn ?? []) visit(d);
      out.push(k);
    };
    [...keys].sort().forEach(visit);
    return out;
  }

  /** The single answer to "what can this actor do here" (docs/FEATURES-AND-PLANS.md §5.4). */
  async capabilities(actor: { id: string; kind: ActorKind }, opts: { previewRole?: string } = {}): Promise<Capabilities> {
    const t = TenantContext.require();
    const pool = await this.db.current();
    const version = Number((await pool.query('SELECT version FROM caps_version')).rows[0]?.version ?? 0);
    const cacheKey = `cap:${t.id}:${actor.id}:${version}:${this.catalogHash}`;
    const cached = opts.previewRole ? null : await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const states = await this.moduleStates(pool);
    const modules = [...states].filter(([, s]) => s === 'ACTIVE').map(([k]) => k);
    const readOnlyModules = [...states].filter(([, s]) => s === 'READ_ONLY' || s === 'DISABLING').map(([k]) => k);
    const activatingModules = [...states].filter(([, s]) => s === 'ACTIVATING').map(([k]) => k);
    const [{ rows: featureRows }, { rows: [plan] }, billing] = await Promise.all([
      pool.query('SELECT feature_key, enabled, limit_value, overage FROM tenant_features'),
      pool.query('SELECT plan_code, plan_name FROM tenant_plan'),
      this.billing(pool),
    ]);
    const planFeatures = new Map(featureRows.map((r) => [r.feature_key as string, { enabled: r.enabled as boolean, limit: r.limit_value == null ? null : Number(r.limit_value), overage: r.overage ?? null }]));
    let roles: { code: string; grants_all: boolean; home: string; perms: string[]; branch_id?: string | null }[];
    if (opts.previewRole) {
      // "preview as role": exactly what someone with only this role would get (role editor)
      const { rows } = await pool.query(`SELECT r.code, r.grants_all, r.home, coalesce(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') perms
        FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.code = $1 GROUP BY r.id`, [opts.previewRole]);
      roles = rows;
    } else if (actor.kind === 'patient') {
      const { rows } = await pool.query(`SELECT r.code, r.grants_all, r.home, coalesce(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') perms
        FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.code = 'PATIENT' GROUP BY r.id`);
      roles = rows;
    } else {
      // one row per grant: the same role can be given at two branches (review B-1)
      const { rows } = await pool.query(`SELECT r.code, r.grants_all, r.home, ur.branch_id, coalesce(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') perms
        FROM user_roles ur JOIN roles r ON r.id = ur.role_id LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE ur.user_id = $1 AND (ur.valid_until IS NULL OR ur.valid_until > now()) GROUP BY r.id, ur.id`, [actor.id]);
      roles = rows;
    }

    // a module no longer in the plan keeps only its "read" permissions: records stay viewable, nothing new is created
    const activePerms = new Set<string>();
    for (const k of modules) for (const p of this.catalog.modules.get(k)!.permissions) activePerms.add(p.code);
    for (const k of readOnlyModules) for (const p of this.catalog.modules.get(k)!.permissions) if (isReadPermission(p.code)) activePerms.add(p.code);
    const permissions = new Set<string>();
    // grants_all (hospital admin) covers every permission of every active module EXCEPT ":own" ones: those act on the
    // user's own identity (a doctor's own schedule, a patient's own appointments) and come with DOCTOR / PATIENT roles.
    for (const r of roles) for (const p of r.grants_all ? [...activePerms].filter((x) => !x.endsWith(':own')) : r.perms) if (activePerms.has(p)) permissions.add(p);
    const { branchScopes, branchIds } = scopesOf(roles, activePerms);

    const features: Record<string, FeatureState> = {};
    for (const m of this.catalog.modules.values()) {
      for (const f of m.features) {
        const p = planFeatures.get(f.key) ?? { enabled: f.default, limit: null, overage: null };
        features[f.key] = !modules.includes(m.key) ? { enabled: false, reason: 'MODULE' } : p.enabled ? { enabled: true, limit: p.limit, ...(f.type === 'METERED' ? { overage: p.overage } : {}) } : { enabled: false, reason: 'PLAN' };
      }
    }

    const nav: NavItem[] = [];
    for (const k of this.dependencyOrder([...modules, ...readOnlyModules])) for (const n of this.catalog.modules.get(k)!.nav) if ((n.audience === 'any' || n.audience === actor.kind) && n.permissions.every((p) => permissions.has(p))) nav.push({ key: n.key, label: n.label, href: n.href, zone: n.zone });

    const order = this.catalog.roles.map((r) => r.code);
    const rank = (code: string) => { const i = order.indexOf(code); return i < 0 ? order.length : i; }; // custom roles after system ones
    const primary = [...roles].sort((a, b) => rank(a.code) - rank(b.code))[0];
    const caps: Capabilities = {
      tenant: { id: t.id, slug: t.slug },
      actor: { id: actor.id, kind: actor.kind },
      roles: roles.map((r) => r.code).sort(),
      modules: modules.sort(),
      readOnlyModules: readOnlyModules.sort(),
      activatingModules: activatingModules.sort(),
      plan: plan ? { code: plan.plan_code, name: plan.plan_name } : null,
      billing,
      permissions: [...permissions].sort(),
      branchScopes,
      branchIds,
      features,
      nav,
      home: primary?.home ?? '/',
      version,
    };
    if (!opts.previewRole) await this.redis.set(cacheKey, JSON.stringify(caps), 'EX', CAP_TTL_S);
    return caps;
  }
}

