import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { type ContractChanged, EventTypes, Topics } from '@mc/contracts';
import { type Catalog, loadCatalog } from '@mc/entitlements-sdk/catalog';
import { CONTROL_DB, DomainError, PLACEMENTS, retryInBackground } from '@mc/nest-common';
import { addToOutbox, envelope, type PlacementSource, type Queryable, withTx } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { type AddonDef, type AddonOption, computeEntitlements, type Effective, type Overrides, type PlanOption, type PlanVersionDef, upsellOptions } from './compute.js';
import { loadPlanCatalog } from './plan-catalog.js';

/**
 * A hospital created without choosing a plan (CLI, or before plans existed) gets everything and no limits, as before
 * Phase 17. Self-serve signup (Phase 20) always chooses one.
 */
const DEFAULT_PLAN = process.env.DEFAULT_PLAN ?? 'HOSPITAL_ENTERPRISE';
/** MediCare's own account: the only one whose plan may contain internal modules (the platform console). */
export const PLATFORM_SLUG = process.env.PLATFORM_TENANT_SLUG ?? 'medicare';

interface VersionRow { id: string; plan_code: string; plan_name: string; edition: string; version: number; list_price: string; status: string }

export interface ChangeInput {
  plan: string;
  version?: number;
  /** an exact version (also RETIRED ones a hospital is being moved off, never DRAFT/PENDING) */
  versionId?: string;
  addons?: { code: string; quantity?: number }[];
  by: string;
  reason: string;
  /** internal plans (MediCare HQ) only from the CLI: they carry the platform console */
  allowInternal?: boolean;
}

export type Contract = Awaited<ReturnType<PlansService['current']>>;

/** Differences between two effective entitlements (impact preview, simulator). */
export function diffEffective(before: Effective, after: Effective) {
  const b = new Set(before.modules.map((m) => m.key));
  const a = new Set(after.modules.map((m) => m.key));
  const features: { key: string; before: { enabled: boolean; limit: number | null } | null; after: { enabled: boolean; limit: number | null } | null }[] = [];
  for (const k of new Set([...Object.keys(before.features), ...Object.keys(after.features)])) {
    const x = before.features[k] ?? null;
    const y = after.features[k] ?? null;
    if (JSON.stringify(x) !== JSON.stringify(y)) features.push({ key: k, before: x, after: y });
  }
  return { modulesAdded: [...a].filter((k) => !b.has(k)), modulesRemoved: [...b].filter((k) => !a.has(k)), features };
}

/** What the audit log keeps of a contract: plan, add-ons, overrides (not the full computed state). */
function prevSnapshot(c: Contract | null) {
  return c ? { plan: `${c.plan.code} v${c.plan.version}`, addons: c.addons.map((a) => `${a.code}×${a.quantity}`), overrides: c.overrides } : null;
}

@Injectable()
export class PlansService implements OnModuleInit, OnApplicationBootstrap {
  private readonly log = new Logger('Plans');
  modules!: Catalog;

  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  async onModuleInit() {
    this.modules = loadCatalog();
    await this.seed();
  }

  /** Hospitals without a contract (created before plans existed) get one; tenant-service may still be starting. */
  onApplicationBootstrap() {
    retryInBackground('ContractBackfill', async () => {
      let n = 0;
      for (const t of await this.placements.list()) {
        if (t.status !== 'ACTIVE' && t.status !== 'READ_ONLY') continue;
        if (await this.change(t.id, { plan: DEFAULT_PLAN, by: 'system', reason: 'hospital created before plans: keeps every module' }, { onlyIfNone: true })) n++;
      }
      if (n) this.log.log(`gave ${n} existing hospital(s) the ${DEFAULT_PLAN} plan`);
    });
  }

  // ---------- catalogue ----------

  /** Insert editions, add-ons and plan versions from modules/plans.yaml; an existing plan version is never changed. */
  private async seed() {
    const seed = loadPlanCatalog(this.modules);
    await withTx(this.db, async (c) => {
      for (const e of seed.editions) {
        await c.query(`INSERT INTO editions (id, code, name, description) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET name = $3, description = $4`, [randomUUID(), e.code, e.name, e.description ?? null]);
      }
      for (const a of seed.addons) {
        await c.query(`INSERT INTO addons (id, code, name, module_key, feature_key, extra_limit, list_price) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING`,
          [randomUUID(), a.code, a.name, a.module ?? null, a.feature ?? null, a.extraLimit ?? null, a.listPrice]);
      }
      for (const [i, p] of seed.plans.entries()) {
        const { rows: [plan] } = await c.query(`INSERT INTO plans (id, code, name, edition_id, tier, sort_order, internal) SELECT $1,$2,$3,id,$5,$6,$7 FROM editions WHERE code = $4
          ON CONFLICT (code) DO UPDATE SET internal = $7 RETURNING id`, [randomUUID(), p.code, p.name, p.edition, p.tier, i, p.internal]);
        for (const v of p.versions) {
          const { rows: [ver] } = await c.query(`INSERT INTO plan_versions (id, plan_id, version, status, list_price, trial_days, published_at) VALUES ($1,$2,$3,'PUBLISHED',$4,$5,now())
            ON CONFLICT (plan_id, version) DO NOTHING RETURNING id`, [randomUUID(), plan.id, v.version, v.listPrice, v.trialDays]);
          if (!ver) continue;
          for (const m of v.modules) await c.query('INSERT INTO plan_version_modules (plan_version_id, module_key) VALUES ($1,$2)', [ver.id, m]);
          for (const [k, f] of Object.entries(v.features)) await c.query('INSERT INTO plan_features (plan_version_id, feature_key, enabled, limit_value, overage) VALUES ($1,$2,$3,$4,$5)', [ver.id, k, f.enabled, f.limit, f.overage ?? null]);
          for (const [k, b] of Object.entries(v.settings)) await c.query('INSERT INTO plan_setting_bounds (plan_version_id, setting_key, min_value, max_value, allowed_values) VALUES ($1,$2,$3,$4,$5)', [ver.id, k, b.min ?? null, b.max ?? null, b.allowed ?? null]);
          for (const a of v.addons) await c.query('INSERT INTO plan_version_addons (plan_version_id, addon_id) SELECT $1, id FROM addons WHERE code = $2', [ver.id, a]);
          // a newer seeded version replaces the older published one for new sales (hospitals keep theirs)
          await c.query(`UPDATE plan_versions SET status = 'RETIRED', retired_at = now() WHERE plan_id = $1 AND status = 'PUBLISHED' AND version < $2`, [plan.id, v.version]);
          this.log.log(`published ${p.code} v${v.version}`);
        }
      }
    });
  }

  async versionDef(c: Queryable, versionId: string): Promise<PlanVersionDef & { addonCodes: string[] }> {
    const [m, f, s, a] = await Promise.all([
      c.query('SELECT module_key FROM plan_version_modules WHERE plan_version_id = $1', [versionId]),
      c.query('SELECT feature_key, enabled, limit_value, overage FROM plan_features WHERE plan_version_id = $1', [versionId]),
      c.query('SELECT setting_key, min_value, max_value, allowed_values FROM plan_setting_bounds WHERE plan_version_id = $1', [versionId]),
      c.query('SELECT a.code FROM plan_version_addons pa JOIN addons a ON a.id = pa.addon_id WHERE pa.plan_version_id = $1 ORDER BY a.code', [versionId]),
    ]);
    return {
      modules: m.rows.map((r) => r.module_key),
      features: Object.fromEntries(f.rows.map((r) => [r.feature_key, { enabled: r.enabled, limit: r.limit_value == null ? null : Number(r.limit_value), overage: r.overage ?? null }])),
      settings: Object.fromEntries(s.rows.map((r) => [r.setting_key, { min: r.min_value == null ? null : Number(r.min_value), max: r.max_value == null ? null : Number(r.max_value), allowed: r.allowed_values }])),
      addonCodes: a.rows.map((r) => r.code),
    };
  }

  private async findVersion(c: Queryable, planCode: string, version?: number, versionId?: string): Promise<VersionRow & { internal: boolean }> {
    const { rows } = await c.query<VersionRow & { internal: boolean }>(`SELECT v.id, p.code plan_code, p.name plan_name, e.code edition, v.version, v.list_price, v.status, p.internal
      FROM plan_versions v JOIN plans p ON p.id = v.plan_id JOIN editions e ON e.id = p.edition_id
      WHERE p.code = $1 AND ($3::uuid IS NOT NULL AND v.id = $3 OR $3::uuid IS NULL AND ($2::int IS NULL AND v.status = 'PUBLISHED' OR v.version = $2)) ORDER BY v.version DESC LIMIT 1`, [planCode, version ?? null, versionId ?? null]);
    if (!rows[0]) throw new DomainError(404, 'UNKNOWN_PLAN', `no published plan ${planCode}${version ? ` v${version}` : ''}`);
    if (rows[0].status !== 'PUBLISHED') throw new DomainError(422, 'PLAN_NOT_PUBLISHED', `${planCode} v${rows[0].version} is ${rows[0].status}`);
    return rows[0];
  }

  /** Every published plan (latest version of each), for the plan comparison and upsell. */
  async plans(c: Queryable = this.db): Promise<(PlanOption & { tier: string; edition: string; editionName: string; trialDays: number; settings: PlanVersionDef['settings'] })[]> {
    const { rows } = await c.query(`SELECT DISTINCT ON (p.id) v.id, p.code, p.name, p.tier, p.sort_order, e.code edition, e.name edition_name, v.version, v.list_price, v.trial_days
      FROM plans p JOIN plan_versions v ON v.plan_id = p.id AND v.status = 'PUBLISHED' JOIN editions e ON e.id = p.edition_id WHERE NOT p.internal ORDER BY p.id, v.version DESC`);
    const out: Awaited<ReturnType<PlansService['plans']>> = [];
    for (const r of rows.sort((a, b) => a.sort_order - b.sort_order)) {
      const def = await this.versionDef(c, r.id);
      out.push({ code: r.code, name: r.name, tier: r.tier, edition: r.edition, editionName: r.edition_name, version: r.version, listPrice: Number(r.list_price), trialDays: r.trial_days, ...def });
    }
    return out;
  }

  async addonList(c: Queryable = this.db): Promise<AddonOption[]> {
    const { rows } = await c.query('SELECT code, name, module_key, feature_key, extra_limit, list_price FROM addons ORDER BY list_price');
    return rows.map((r) => ({ code: r.code, name: r.name, module: r.module_key, feature: r.feature_key, extraLimit: r.extra_limit == null ? null : Number(r.extra_limit), listPrice: Number(r.list_price) }));
  }

  // ---------- contracts ----------

  private async contractAddons(c: Queryable, contractId: string): Promise<AddonDef[]> {
    const { rows } = await c.query(`SELECT a.code, a.name, a.module_key, a.feature_key, a.extra_limit, ca.quantity FROM contract_addons ca JOIN addons a ON a.id = ca.addon_id WHERE ca.contract_id = $1 ORDER BY a.code`, [contractId]);
    return rows.map((r) => ({ code: r.code, name: r.name, module: r.module_key, feature: r.feature_key, extraLimit: r.extra_limit == null ? null : Number(r.extra_limit), quantity: r.quantity }));
  }

  /** The hospital's active contract with its plan, add-ons and effective entitlements. */
  async current(tenantId: string, c: Queryable = this.db) {
    const { rows } = await c.query(`SELECT ct.id, ct.plan_version_id, ct.overrides, ct.starts_at, ct.created_by, ct.reason, p.code plan_code, p.name plan_name, p.tier, e.code edition, e.name edition_name, v.version, v.list_price
      FROM contracts ct JOIN plan_versions v ON v.id = ct.plan_version_id JOIN plans p ON p.id = v.plan_id JOIN editions e ON e.id = p.edition_id
      WHERE ct.tenant_id = $1 AND ct.status = 'ACTIVE'`, [tenantId]);
    const r = rows[0];
    if (!r) throw new DomainError(404, 'NO_CONTRACT', 'this hospital has no plan yet');
    const def = await this.versionDef(c, r.plan_version_id);
    const addons = await this.contractAddons(c, r.id);
    const eff = computeEntitlements(this.modules, def, addons, r.overrides as Overrides);
    return {
      contractId: r.id as string,
      plan: { code: r.plan_code as string, name: r.plan_name as string, tier: r.tier as string, edition: r.edition as string, editionName: r.edition_name as string, version: r.version as number, listPrice: Number(r.list_price), addonCodes: def.addonCodes, modules: def.modules, features: def.features, settings: def.settings },
      addons,
      overrides: r.overrides as Overrides,
      since: r.starts_at as Date,
      by: r.created_by as string,
      reason: r.reason as string,
      effective: { modules: eff.modules, features: eff.features, settingBounds: eff.settingBounds } as Effective,
    };
  }

  /** Move a hospital to a plan (version) with add-ons. Upgrades and downgrades apply now (billing timing: Phase 19). */
  async change(tenantId: string, input: ChangeInput, opts: { onlyIfNone: true }): Promise<Awaited<ReturnType<PlansService['current']>> | null>;
  async change(tenantId: string, input: ChangeInput): Promise<Awaited<ReturnType<PlansService['current']>>>;
  async change(tenantId: string, input: ChangeInput, opts: { onlyIfNone?: boolean } = {}) {
    return withTx(this.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`contract:${tenantId}`]);
      // first contract only (signup event and start-up backfill may both try): checked under the lock
      if (opts.onlyIfNone && (await c.query(`SELECT 1 FROM contracts WHERE tenant_id = $1 AND status = 'ACTIVE'`, [tenantId])).rows[0]) return null;
      const v = await this.findVersion(c, input.plan, input.version, input.versionId);
      if (v.internal && !input.allowInternal) throw new DomainError(422, 'PLAN_INTERNAL', `${v.plan_code} is MediCare's own plan and cannot be given to a hospital`);
      const hadContract = !!(await c.query(`SELECT 1 FROM contracts WHERE tenant_id = $1 AND status = 'ACTIVE'`, [tenantId])).rows[0];
      const before = hadContract ? prevSnapshot(await this.current(tenantId, c)) : null;
      const def = await this.versionDef(c, v.id);
      const all = await this.addonList(c);
      const addons: AddonDef[] = [];
      for (const a of input.addons ?? []) {
        const x = all.find((y) => y.code === a.code);
        if (!x) throw new DomainError(404, 'UNKNOWN_ADDON', `no add-on ${a.code}`);
        if (!def.addonCodes.includes(a.code)) throw new DomainError(422, 'ADDON_NOT_ALLOWED', `${a.code} cannot be added to ${v.plan_code}`, { allowed: def.addonCodes });
        addons.push({ code: x.code, name: x.name, module: x.module, feature: x.feature, extraLimit: x.extraLimit, quantity: a.quantity ?? 1 });
      }
      const { rows: [prev] } = await c.query(`SELECT id, overrides FROM contracts WHERE tenant_id = $1 AND status = 'ACTIVE' FOR UPDATE`, [tenantId]);
      // support/sales exceptions stay with the hospital across plan changes
      const overrides = (prev?.overrides ?? {}) as Overrides;
      this.assertValid(computeEntitlements(this.modules, def, addons, overrides));
      if (prev) await c.query(`UPDATE contracts SET status = 'ENDED', ended_at = now() WHERE id = $1`, [prev.id]);
      const id = randomUUID();
      await c.query(`INSERT INTO contracts (id, tenant_id, plan_version_id, status, overrides, created_by, reason) VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6)`, [id, tenantId, v.id, overrides, input.by, input.reason]);
      for (const a of addons) await c.query('INSERT INTO contract_addons (contract_id, addon_id, quantity) SELECT $1, id, $3 FROM addons WHERE code = $2', [id, a.code, a.quantity]);
      await this.publish(c, tenantId, input.reason);
      const after = await this.current(tenantId, c);
      await this.audit(c, input.by, 'CONTRACT_CHANGED', 'TENANT', tenantId, await this.slug(tenantId), before, prevSnapshot(after), input.reason);
      this.log.log(`tenant ${tenantId} → ${v.plan_code} v${v.version}${addons.length ? ` + ${addons.map((a) => a.code).join(', ')}` : ''} (${input.reason})`);
      return this.current(tenantId, c);
    });
  }

  /** Switch one module on/off for one hospital outside its plan (support, pilots), or back to what the plan says. */
  async overrideModule(tenantId: string, key: string, state: 'on' | 'off' | 'plan', by: string, reason?: string) {
    if (!this.modules.modules.has(key)) throw new DomainError(404, 'UNKNOWN_MODULE', `module ${key} does not exist`);
    if (this.modules.modules.get(key)!.internal && state === 'on') throw new DomainError(422, 'MODULE_INTERNAL', `module ${key} is MediCare's own and cannot be switched on for a hospital`);
    if (this.modules.modules.get(key)!.alwaysOn && state === 'off') throw new DomainError(422, 'MODULE_ALWAYS_ON', `module ${key} cannot be switched off`);
    return withTx(this.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`contract:${tenantId}`]);
      const cur = await this.current(tenantId, c);
      const overrides: Overrides = { ...cur.overrides, modules: { ...cur.overrides.modules } };
      if (state === 'plan') delete overrides.modules![key];
      else overrides.modules![key] = state === 'on';
      this.assertValid(computeEntitlements(this.modules, cur.plan, cur.addons, overrides));
      await c.query('UPDATE contracts SET overrides = $2 WHERE id = $1', [cur.contractId, overrides]);
      const what = `module ${key} ${state === 'plan' ? 'back to the plan' : `switched ${state}`}`;
      await this.publish(c, tenantId, `${what} by ${by}`);
      await this.audit(c, by, 'MODULE_OVERRIDE', 'TENANT', tenantId, await this.slug(tenantId), { modules: cur.overrides.modules ?? {} }, { modules: overrides.modules }, reason ?? what);
      return this.current(tenantId, c);
    });
  }

  /** A feature switch or limit for one hospital outside its plan (e.g. 40 branches on a 25-branch plan); null = back to the plan. */
  async overrideFeature(tenantId: string, key: string, value: { enabled?: boolean; limit?: number | null } | null, by: string, reason: string) {
    const def = [...this.modules.modules.values()].flatMap((m) => m.features).find((f) => f.key === key);
    if (!def) throw new DomainError(404, 'UNKNOWN_FEATURE', `feature ${key} does not exist`);
    if (value && 'limit' in value && def.type === 'BOOLEAN') throw new DomainError(422, 'NOT_A_LIMIT', `${def.name} has no limit`);
    return withTx(this.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`contract:${tenantId}`]);
      const cur = await this.current(tenantId, c);
      const features = { ...cur.overrides.features };
      if (value) features[key] = value;
      else delete features[key];
      const overrides: Overrides = { ...cur.overrides, features };
      await c.query('UPDATE contracts SET overrides = $2 WHERE id = $1', [cur.contractId, overrides]);
      await this.publish(c, tenantId, `${def.name} ${value ? 'set' : 'back to the plan'} by ${by}`);
      await this.audit(c, by, 'FEATURE_OVERRIDE', 'TENANT', tenantId, await this.slug(tenantId), { [key]: cur.overrides.features?.[key] ?? null }, { [key]: value }, reason);
      return this.current(tenantId, c);
    });
  }

  /** "What would this hospital get on that plan version?" (keeps its overrides; add-ons as given). Nothing is saved. */
  async simulate(tenantId: string, versionId: string, addonCodes: { code: string; quantity?: number }[]) {
    const cur = await this.current(tenantId);
    const { rows: [v] } = await this.db.query(`SELECT v.id, v.version, v.status, v.list_price, p.code, p.name, p.internal FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = $1`, [versionId]);
    if (!v) throw new DomainError(404, 'NOT_FOUND', 'plan version not found');
    const def = await this.versionDef(this.db, versionId);
    const all = await this.addonList();
    const addons: AddonDef[] = addonCodes.map((a) => {
      const x = all.find((y) => y.code === a.code);
      if (!x) throw new DomainError(404, 'UNKNOWN_ADDON', `no add-on ${a.code}`);
      return { code: x.code, name: x.name, module: x.module, feature: x.feature, extraLimit: x.extraLimit, quantity: a.quantity ?? 1 };
    });
    const notAllowed = addons.filter((a) => !def.addonCodes.includes(a.code)).map((a) => a.code);
    const eff = computeEntitlements(this.modules, def, addons, cur.overrides);
    const price = Number(v.list_price) + addons.reduce((sum, a) => sum + (all.find((x) => x.code === a.code)?.listPrice ?? 0) * a.quantity, 0);
    const currentPrice = cur.plan.listPrice + cur.addons.reduce((sum, a) => sum + (all.find((x) => x.code === a.code)?.listPrice ?? 0) * a.quantity, 0);
    return {
      plan: { code: v.code, name: v.name, version: v.version, status: v.status, internal: v.internal },
      price, currentPrice,
      effective: { modules: eff.modules, features: eff.features, settingBounds: eff.settingBounds },
      diff: diffEffective(cur.effective, eff),
      problems: [...eff.problems, ...notAllowed.map((a) => `add-on ${a} is not sold with this plan`), ...(v.internal ? ['internal plan'] : [])],
    };
  }

  /** Hospital slug for audit labels (placements are cached). */
  async slug(tenantId: string) {
    return (await this.placements.get(tenantId).catch(() => null))?.slug ?? tenantId;
  }

  /** Append to the platform audit log (same transaction as the change). */
  /** One audit entry outside a transaction (console actions that call other services). */
  async auditOnce(actor: string, action: string, tenantId: string, label: string, note: string) {
    await this.audit(this.db, actor, action, 'TENANT', tenantId, label, null, null, note);
  }

  async audit(c: Queryable, actor: string, action: string, targetType: string, targetId: string, label: string | null, before: unknown, after: unknown, note?: string | null) {
    await c.query(`INSERT INTO platform_audit (actor, action, target_type, target_id, target_label, before, after, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actor, action, targetType, targetId, label, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), note ?? null]);
  }

  private assertValid(e: { problems: string[] }) {
    if (e.problems.length) throw new DomainError(422, 'MODULE_DEPENDENCY', e.problems.join('; '), { problems: e.problems });
  }

  /** Tell entitlement-service the hospital's full effective entitlements (event-carried state). */
  private async publish(c: Queryable, tenantId: string, reason: string) {
    const cur = await this.current(tenantId, c);
    const { rows: [s] } = await c.query(`INSERT INTO tenant_seq (tenant_id, seq) VALUES ($1, 1) ON CONFLICT (tenant_id) DO UPDATE SET seq = tenant_seq.seq + 1 RETURNING seq`, [tenantId]);
    const data: ContractChanged = {
      contractId: cur.contractId,
      seq: s.seq,
      plan: { code: cur.plan.code, name: cur.plan.name, version: cur.plan.version, edition: cur.plan.edition, listPrice: cur.plan.listPrice },
      addons: cur.addons.map((a) => ({ code: a.code, name: a.name, quantity: a.quantity })),
      ...cur.effective,
      reason,
    };
    await addToOutbox(c, Topics.subscription, tenantId, envelope(EventTypes.contractChanged, data, { tenantId, subject: cur.contractId }));
  }

  /** Re-send the current entitlements (e.g. after entitlement-service lost its copy). */
  async republish(tenantId: string) {
    await withTx(this.db, (c) => this.publish(c, tenantId, 'republished'));
  }

  /** How many contract changes were published for this hospital (ContractChanged.seq of the latest). */
  async seq(tenantId: string): Promise<number> {
    return (await this.db.query('SELECT seq FROM tenant_seq WHERE tenant_id = $1', [tenantId])).rows[0]?.seq ?? 0;
  }

  async history(tenantId: string) {
    const { rows } = await this.db.query(`SELECT ct.id, p.code plan, v.version, ct.status, ct.starts_at, ct.ended_at, ct.created_by, ct.reason
      FROM contracts ct JOIN plan_versions v ON v.id = ct.plan_version_id JOIN plans p ON p.id = v.plan_id WHERE ct.tenant_id = $1 ORDER BY ct.starts_at DESC`, [tenantId]);
    return rows.map((r) => ({ id: r.id, plan: r.plan, version: r.version, status: r.status, startsAt: r.starts_at, endedAt: r.ended_at, by: r.created_by, reason: r.reason }));
  }

  /** tenant.provisioned: the plan chosen at signup (or the default). */
  async onTenantProvisioned(tenantId: string, slug: string, plan: string | null) {
    // internal plans only for MediCare's own account (created with `mc seed demo` / `mc tenant create medicare --plan MEDICARE_HQ`)
    await this.change(tenantId, { plan: plan ?? DEFAULT_PLAN, by: 'signup', reason: 'new hospital', allowInternal: slug === PLATFORM_SLUG }, { onlyIfNone: true });
  }

  // ---------- upsell ----------

  async upsell(tenantId: string, q: { module?: string; feature?: string }) {
    let module = q.module;
    let featureName: string | undefined;
    if (q.feature) {
      const owner = [...this.modules.modules.values()].find((m) => m.features.some((f) => f.key === q.feature));
      if (!owner) throw new DomainError(404, 'UNKNOWN_FEATURE', `feature ${q.feature} does not exist`);
      module = owner.key;
      featureName = owner.features.find((f) => f.key === q.feature)!.name;
    }
    const m = module ? this.modules.modules.get(module) : undefined;
    if (!m) throw new DomainError(404, 'UNKNOWN_MODULE', `module ${module ?? '?'} does not exist`);
    const cur = await this.current(tenantId);
    const options = upsellOptions(this.modules, { plan: { ...cur.plan, addonCodes: cur.plan.addonCodes }, effective: cur.effective, addons: cur.addons }, { module: m.key, feature: q.feature }, await this.plans(), await this.addonList());
    return {
      target: { module: m.key, moduleName: m.name, feature: q.feature ?? null, featureName: featureName ?? null },
      current: { plan: cur.plan.code, name: cur.plan.name, listPrice: cur.plan.listPrice },
      options,
    };
  }
}
