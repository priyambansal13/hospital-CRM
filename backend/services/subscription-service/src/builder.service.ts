import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONTROL_DB, DomainError, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, type Queryable, withTx } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { type AddonDef, computeEntitlements } from './compute.js';
import { validateVersion, type VersionDraft } from './plan-catalog.js';
import { diffEffective, PlansService } from './plans.service.js';

/** The MediCare user doing something in the console (audit, two-person rule). */
export interface Who { id: string; label: string }

/**
 * The plan builder (docs/PRODUCT-MODULES-AND-PLANS.md §11): editions, plans, draft versions validated against the
 * module manifests, two-person approval to publish (with impact preview and an optional "move everyone now"), retiring.
 * Everything is written to the platform audit log.
 */
@Injectable()
export class BuilderService {
  private readonly log = new Logger('PlanBuilder');
  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool, private readonly plans: PlansService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  private get modules() {
    return this.plans.modules;
  }

  // ---------- registry and editions ----------

  registry() {
    return [...this.modules.modules.values()].map((m) => ({
      key: m.key, name: m.name, version: m.version, alwaysOn: m.alwaysOn, internal: m.internal, dependsOn: m.dependsOn, services: m.services,
      features: m.features, settings: m.settings, permissions: m.permissions, lifecycle: m.lifecycle,
    }));
  }

  async editions() {
    const { rows } = await this.db.query(`SELECT e.code, e.name, e.description, count(p.id) FILTER (WHERE NOT p.internal)::int plans FROM editions e LEFT JOIN plans p ON p.edition_id = e.id GROUP BY e.id ORDER BY e.name`);
    return rows;
  }

  async saveEdition(who: Who, e: { code: string; name: string; description?: string | null }) {
    return withTx(this.db, async (c) => {
      const { rows: [before] } = await c.query('SELECT code, name, description FROM editions WHERE code = $1', [e.code]);
      await c.query(`INSERT INTO editions (id, code, name, description) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET name = $3, description = $4`, [randomUUID(), e.code, e.name, e.description ?? null]);
      await this.plans.audit(c, who.label, before ? 'EDITION_UPDATED' : 'EDITION_CREATED', 'EDITION', e.code, e.name, before ?? null, e);
      return { code: e.code, name: e.name, description: e.description ?? null };
    });
  }

  // ---------- plans and versions ----------

  /** Every plan (internal ones too) with all its versions and how many hospitals are on each. */
  async listPlans() {
    const { rows } = await this.db.query(`SELECT p.code, p.name, p.tier, p.internal, p.description, e.code edition, e.name edition_name,
        v.id version_id, v.version, v.status, v.list_price, v.created_by, v.submitted_by, v.approved_by, v.published_at, v.updated_at,
        (SELECT count(*) FROM contracts c WHERE c.plan_version_id = v.id AND c.status = 'ACTIVE')::int hospitals
      FROM plans p JOIN editions e ON e.id = p.edition_id LEFT JOIN plan_versions v ON v.plan_id = p.id ORDER BY p.internal, p.sort_order, p.code, v.version DESC`);
    const out = new Map<string, any>();
    for (const r of rows) {
      if (!out.has(r.code)) out.set(r.code, { code: r.code, name: r.name, tier: r.tier, internal: r.internal, description: r.description, edition: r.edition, editionName: r.edition_name, versions: [] });
      if (r.version_id) out.get(r.code).versions.push({ id: r.version_id, version: r.version, status: r.status, listPrice: Number(r.list_price), createdBy: r.created_by, submittedBy: r.submitted_by, approvedBy: r.approved_by, publishedAt: r.published_at, updatedAt: r.updated_at, hospitals: r.hospitals });
    }
    return [...out.values()];
  }

  private async addonMap(c: Queryable) {
    return new Map((await this.plans.addonList(c)).map((a) => [a.code, a]));
  }

  private async versionRow(c: Queryable, id: string, lock = false) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError(404, 'NOT_FOUND', 'plan version not found');
    const { rows: [v] } = await c.query(`SELECT v.*, p.code plan_code, p.name plan_name, p.internal, p.id plan_id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = $1 ${lock ? 'FOR UPDATE OF v' : ''}`, [id]);
    if (!v) throw new DomainError(404, 'NOT_FOUND', 'plan version not found');
    return v;
  }

  private async draftOf(c: Queryable, id: string): Promise<VersionDraft> {
    const v = await this.versionRow(c, id);
    const def = await this.plans.versionDef(c, id);
    return { listPrice: Number(v.list_price), trialDays: v.trial_days, modules: def.modules.sort(), features: def.features, settings: def.settings, addons: def.addonCodes };
  }

  /** One version: its definition, validation problems, and what the builder needs to edit it. */
  async version(id: string) {
    const v = await this.versionRow(this.db, id);
    const draft = await this.draftOf(this.db, id);
    const problems = validateVersion(this.modules, draft, await this.addonMap(this.db), { internal: v.internal });
    const { rows: [n] } = await this.db.query(`SELECT count(*)::int hospitals FROM contracts WHERE plan_version_id = $1 AND status = 'ACTIVE'`, [id]);
    return {
      id: v.id, plan: { code: v.plan_code, name: v.plan_name, internal: v.internal }, version: v.version, status: v.status,
      createdBy: v.created_by, updatedBy: v.updated_by, updatedAt: v.updated_at, submittedBy: v.submitted_by, submittedAt: v.submitted_at,
      approvedBy: v.approved_by, publishedAt: v.published_at, reviewNote: v.review_note, migration: v.migration,
      definition: draft, problems, hospitals: n.hospitals, addons: await this.plans.addonList(),
    };
  }

  private async writeDefinition(c: Queryable, id: string, d: VersionDraft) {
    await c.query('UPDATE plan_versions SET list_price = $2, trial_days = $3 WHERE id = $1', [id, d.listPrice, d.trialDays ?? 0]);
    for (const t of ['plan_version_modules', 'plan_features', 'plan_setting_bounds', 'plan_version_addons']) await c.query(`DELETE FROM ${t} WHERE plan_version_id = $1`, [id]);
    for (const m of new Set(d.modules)) await c.query('INSERT INTO plan_version_modules (plan_version_id, module_key) VALUES ($1,$2)', [id, m]);
    for (const [k, f] of Object.entries(d.features)) await c.query('INSERT INTO plan_features (plan_version_id, feature_key, enabled, limit_value, overage) VALUES ($1,$2,$3,$4,$5)', [id, k, f.enabled, f.limit, f.overage ?? null]);
    for (const [k, b] of Object.entries(d.settings)) await c.query('INSERT INTO plan_setting_bounds (plan_version_id, setting_key, min_value, max_value, allowed_values) VALUES ($1,$2,$3,$4,$5)', [id, k, b.min ?? null, b.max ?? null, b.allowed ?? null]);
    for (const a of new Set(d.addons)) await c.query('INSERT INTO plan_version_addons (plan_version_id, addon_id) SELECT $1, id FROM addons WHERE code = $2', [id, a]);
  }

  /** A new plan with a first draft: empty (core only) or a copy of another plan's latest version. */
  async createPlan(who: Who, p: { code: string; name: string; edition: string; tier: string; description?: string | null; copyFrom?: string | null }) {
    return withTx(this.db, async (c) => {
      const { rows: [e] } = await c.query('SELECT id FROM editions WHERE code = $1', [p.edition]);
      if (!e) throw new DomainError(422, 'UNKNOWN_EDITION', `no edition ${p.edition}`);
      const { rows: [dup] } = await c.query('SELECT 1 FROM plans WHERE code = $1', [p.code]);
      if (dup) throw new DomainError(409, 'PLAN_EXISTS', `a plan with code ${p.code} already exists`);
      let draft: VersionDraft = { listPrice: 0, trialDays: 0, modules: ['core'], features: {}, settings: {}, addons: [] };
      if (p.copyFrom) {
        const { rows: [src] } = await c.query(`SELECT v.id FROM plan_versions v JOIN plans x ON x.id = v.plan_id WHERE x.code = $1 AND NOT x.internal ORDER BY (v.status = 'PUBLISHED') DESC, v.version DESC LIMIT 1`, [p.copyFrom]);
        if (!src) throw new DomainError(404, 'UNKNOWN_PLAN', `no plan ${p.copyFrom} to copy`);
        draft = await this.draftOf(c, src.id);
      }
      const planId = randomUUID();
      const { rows: [o] } = await c.query('SELECT coalesce(max(sort_order), 0) + 1 n FROM plans');
      await c.query('INSERT INTO plans (id, code, name, edition_id, tier, sort_order, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [planId, p.code, p.name, e.id, p.tier, o.n, p.description ?? null, who.label]);
      const id = randomUUID();
      await c.query(`INSERT INTO plan_versions (id, plan_id, version, status, list_price, trial_days, created_by, updated_by) VALUES ($1,$2,1,'DRAFT',$3,$4,$5,$5)`, [id, planId, draft.listPrice, draft.trialDays ?? 0, who.label]);
      await this.writeDefinition(c, id, draft);
      await this.plans.audit(c, who.label, 'PLAN_CREATED', 'PLAN', p.code, p.name, null, { ...p, draft }, p.copyFrom ? `copied from ${p.copyFrom}` : null);
      this.log.log(`${who.label} created plan ${p.code} (draft v1)`);
      return { planCode: p.code, versionId: id };
    });
  }

  /** Next version of a plan as a draft, starting from its latest version. */
  async newVersion(who: Who, planCode: string) {
    return withTx(this.db, async (c) => {
      const { rows: [p] } = await c.query('SELECT id, internal FROM plans WHERE code = $1 FOR UPDATE', [planCode]);
      if (!p) throw new DomainError(404, 'UNKNOWN_PLAN', `no plan ${planCode}`);
      const { rows: [open] } = await c.query(`SELECT id, version, status FROM plan_versions WHERE plan_id = $1 AND status IN ('DRAFT','PENDING')`, [p.id]);
      if (open) throw new DomainError(409, 'DRAFT_EXISTS', `v${open.version} is already ${open.status === 'DRAFT' ? 'a draft' : 'waiting for approval'}`, { versionId: open.id });
      const { rows: [last] } = await c.query('SELECT id, version FROM plan_versions WHERE plan_id = $1 ORDER BY version DESC LIMIT 1', [p.id]);
      const draft = last ? await this.draftOf(c, last.id) : { listPrice: 0, trialDays: 0, modules: ['core'], features: {}, settings: {}, addons: [] };
      const id = randomUUID();
      const version = (last?.version ?? 0) + 1;
      await c.query(`INSERT INTO plan_versions (id, plan_id, version, status, list_price, trial_days, created_by, updated_by) VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$6)`, [id, p.id, version, draft.listPrice, draft.trialDays ?? 0, who.label]);
      await this.writeDefinition(c, id, draft);
      await this.plans.audit(c, who.label, 'VERSION_CREATED', 'PLAN_VERSION', id, `${planCode} v${version}`, null, draft);
      return { planCode, versionId: id, version };
    });
  }

  /** Save a draft (only DRAFT versions change). Saved even with problems; submitting needs none. */
  async saveDraft(who: Who, id: string, d: VersionDraft) {
    return withTx(this.db, async (c) => {
      const v = await this.versionRow(c, id, true);
      if (v.status !== 'DRAFT') throw new DomainError(409, 'NOT_A_DRAFT', `v${v.version} is ${v.status}: published versions never change, create a new version`);
      const before = await this.draftOf(c, id);
      const clean: VersionDraft = {
        ...d,
        modules: [...new Set(d.modules)].sort(),
        // keep only features/settings of included modules (unticking a module drops its settings)
        features: Object.fromEntries(Object.entries(d.features).filter(([k]) => d.modules.includes(k.split('.')[0]))),
        settings: Object.fromEntries(Object.entries(d.settings).filter(([k]) => d.modules.includes(k.split('.')[0]))),
      };
      await this.writeDefinition(c, id, clean);
      await c.query('UPDATE plan_versions SET updated_by = $2, updated_at = now(), review_note = NULL WHERE id = $1', [id, who.label]);
      await this.plans.audit(c, who.label, 'VERSION_SAVED', 'PLAN_VERSION', id, `${v.plan_code} v${v.version}`, before, clean);
      return { problems: validateVersion(this.modules, clean, await this.addonMap(c), { internal: v.internal }) };
    });
  }

  async submit(who: Who, id: string) {
    return withTx(this.db, async (c) => {
      const v = await this.versionRow(c, id, true);
      if (v.status !== 'DRAFT') throw new DomainError(409, 'NOT_A_DRAFT', `v${v.version} is ${v.status}`);
      const problems = validateVersion(this.modules, await this.draftOf(c, id), await this.addonMap(c), { internal: v.internal });
      if (problems.length) throw new DomainError(422, 'PLAN_INVALID', `fix these first: ${problems.join('; ')}`, { problems });
      await c.query(`UPDATE plan_versions SET status = 'PENDING', submitted_by = $2, submitted_at = now() WHERE id = $1`, [id, who.label]);
      await this.plans.audit(c, who.label, 'VERSION_SUBMITTED', 'PLAN_VERSION', id, `${v.plan_code} v${v.version}`, null, null);
      return { id, status: 'PENDING', submittedBy: who.label };
    });
  }

  /**
   * Impact preview before publishing: hospitals on other versions of this plan and what moving them would change
   * (modules gained/lost, limits, price; problems such as an add-on no longer sold with it or a broken dependency).
   */
  async impact(id: string) {
    const v = await this.versionRow(this.db, id);
    const def = await this.plans.versionDef(this.db, id);
    const all = await this.plans.addonList();
    const { rows } = await this.db.query(`SELECT c.tenant_id, pv.version FROM contracts c JOIN plan_versions pv ON pv.id = c.plan_version_id WHERE pv.plan_id = $1 AND c.status = 'ACTIVE' AND pv.id <> $2 ORDER BY pv.version, c.starts_at`, [v.plan_id, id]);
    const hospitals = [];
    for (const r of rows) {
      const cur = await this.plans.current(r.tenant_id);
      const kept = cur.addons.filter((a) => def.addonCodes.includes(a.code));
      const dropped = cur.addons.filter((a) => !def.addonCodes.includes(a.code)).map((a) => a.code);
      const eff = computeEntitlements(this.modules, def, kept as AddonDef[], cur.overrides);
      const price = Number(v.list_price) + kept.reduce((s, a) => s + (all.find((x) => x.code === a.code)?.listPrice ?? 0) * a.quantity, 0);
      const was = cur.plan.listPrice + cur.addons.reduce((s, a) => s + (all.find((x) => x.code === a.code)?.listPrice ?? 0) * a.quantity, 0);
      hospitals.push({ tenantId: r.tenant_id, slug: await this.plans.slug(r.tenant_id), fromVersion: r.version, diff: diffEffective(cur.effective, eff), price: { before: was, after: price }, droppedAddons: dropped, problems: eff.problems });
    }
    const { rows: [prev] } = await this.db.query(`SELECT id, version FROM plan_versions WHERE plan_id = $1 AND status = 'PUBLISHED' AND id <> $2 ORDER BY version DESC LIMIT 1`, [v.plan_id, id]);
    let versusPublished = null;
    if (prev) {
      const before = computeEntitlements(this.modules, await this.plans.versionDef(this.db, prev.id), []);
      const after = computeEntitlements(this.modules, def, []);
      versusPublished = { version: prev.version, ...diffEffective(before, after), price: { before: Number((await this.versionRow(this.db, prev.id)).list_price), after: Number(v.list_price) } };
    }
    return { plan: v.plan_code, version: v.version, versusPublished, hospitals, summary: { hospitals: hospitals.length, losingModules: hospitals.filter((h) => h.diff.modulesRemoved.length).length, withProblems: hospitals.filter((h) => h.problems.length || h.droppedAddons.length).length } };
  }

  /**
   * Second person approves: PENDING → PUBLISHED (older published versions of the plan → RETIRED: no longer sold,
   * hospitals keep them). MIGRATE_NOW then moves those hospitals to the new version (their allowed add-ons kept).
   */
  async approve(who: Who, id: string, migration: 'NEW_ONLY' | 'MIGRATE_NOW', note?: string | null) {
    const v = await withTx(this.db, async (c) => {
      const v = await this.versionRow(c, id, true);
      if (v.status !== 'PENDING') throw new DomainError(409, 'NOT_PENDING', `v${v.version} is ${v.status}: only versions waiting for approval can be published`);
      // two-person rule: whoever built or submitted it cannot also publish it
      if ([v.submitted_by, v.updated_by, v.created_by].includes(who.label)) throw new DomainError(403, 'TWO_PERSON_RULE', 'someone other than the person who built or submitted this version must approve it');
      const problems = validateVersion(this.modules, await this.draftOf(c, id), await this.addonMap(c), { internal: v.internal });
      if (problems.length) throw new DomainError(422, 'PLAN_INVALID', problems.join('; '), { problems });
      const { rows: retired } = await c.query(`UPDATE plan_versions SET status = 'RETIRED', retired_at = now() WHERE plan_id = $1 AND status = 'PUBLISHED' RETURNING version`, [v.plan_id]);
      await c.query(`UPDATE plan_versions SET status = 'PUBLISHED', approved_by = $2, published_at = now(), migration = $3, review_note = $4 WHERE id = $1`, [id, who.label, migration, note ?? null]);
      await this.plans.audit(c, who.label, 'VERSION_PUBLISHED', 'PLAN_VERSION', id, `${v.plan_code} v${v.version}`, { retired: retired.map((r) => r.version) }, { migration }, note);
      return v;
    });
    const moved: string[] = [];
    const failed: { slug: string; error: string }[] = [];
    if (migration === 'MIGRATE_NOW') {
      const def = await this.plans.versionDef(this.db, id);
      const { rows } = await this.db.query(`SELECT c.tenant_id FROM contracts c JOIN plan_versions pv ON pv.id = c.plan_version_id WHERE pv.plan_id = $1 AND c.status = 'ACTIVE' AND pv.id <> $2`, [v.plan_id, id]);
      for (const r of rows) {
        const cur = await this.plans.current(r.tenant_id);
        try {
          await this.plans.change(r.tenant_id, { plan: v.plan_code, versionId: id, addons: cur.addons.filter((a) => def.addonCodes.includes(a.code)).map((a) => ({ code: a.code, quantity: a.quantity })), by: who.label, reason: `moved to ${v.plan_code} v${v.version} when it was published`, allowInternal: v.internal });
          moved.push(await this.plans.slug(r.tenant_id));
        } catch (e) {
          failed.push({ slug: await this.plans.slug(r.tenant_id), error: (e as Error).message });
        }
      }
    }
    this.log.log(`${who.label} published ${v.plan_code} v${v.version} (${migration}${moved.length ? `, moved ${moved.length}` : ''})`);
    return { ...(await this.version(id)), moved, failed };
  }

  async reject(who: Who, id: string, note: string) {
    return withTx(this.db, async (c) => {
      const v = await this.versionRow(c, id, true);
      if (v.status !== 'PENDING') throw new DomainError(409, 'NOT_PENDING', `v${v.version} is ${v.status}`);
      await c.query(`UPDATE plan_versions SET status = 'DRAFT', review_note = $2, submitted_by = NULL, submitted_at = NULL WHERE id = $1`, [id, note]);
      await this.plans.audit(c, who.label, 'VERSION_REJECTED', 'PLAN_VERSION', id, `${v.plan_code} v${v.version}`, null, null, note);
      return { id, status: 'DRAFT', reviewNote: note };
    });
  }

  /** Stop selling a published version (hospitals on it keep it until moved). */
  async retire(who: Who, id: string) {
    return withTx(this.db, async (c) => {
      const v = await this.versionRow(c, id, true);
      if (v.status !== 'PUBLISHED') throw new DomainError(409, 'NOT_PUBLISHED', `v${v.version} is ${v.status}`);
      if (v.internal) throw new DomainError(422, 'PLAN_INTERNAL', 'MediCare HQ\'s plan cannot be retired');
      await c.query(`UPDATE plan_versions SET status = 'RETIRED', retired_at = now() WHERE id = $1`, [id]);
      await this.plans.audit(c, who.label, 'VERSION_RETIRED', 'PLAN_VERSION', id, `${v.plan_code} v${v.version}`, null, null);
      return { id, status: 'RETIRED' };
    });
  }

  /** Throw away a draft that was never published (a new plan's only draft takes the plan with it). */
  async discard(who: Who, id: string) {
    return withTx(this.db, async (c) => {
      const v = await this.versionRow(c, id, true);
      if (v.status !== 'DRAFT') throw new DomainError(409, 'NOT_A_DRAFT', `v${v.version} is ${v.status}: only drafts can be discarded`);
      for (const t of ['plan_version_modules', 'plan_features', 'plan_setting_bounds', 'plan_version_addons']) await c.query(`DELETE FROM ${t} WHERE plan_version_id = $1`, [id]);
      await c.query('DELETE FROM plan_versions WHERE id = $1', [id]);
      const { rows: [left] } = await c.query('SELECT 1 FROM plan_versions WHERE plan_id = $1', [v.plan_id]);
      if (!left) await c.query('DELETE FROM plans WHERE id = $1', [v.plan_id]);
      await this.plans.audit(c, who.label, 'VERSION_DISCARDED', 'PLAN_VERSION', id, `${v.plan_code} v${v.version}`, null, null);
      return { discarded: true, planRemoved: !left };
    });
  }

  // ---------- hospitals ----------

  async hospitals(opts: { fresh?: boolean } = {}) {
    if (opts.fresh) this.placements.invalidate?.();
    const { rows } = await this.db.query(`SELECT c.tenant_id, p.code, p.name, p.internal, pv.version, pv.status version_status, c.starts_at, c.overrides,
        (SELECT coalesce(json_agg(a.code ORDER BY a.code), '[]') FROM contract_addons ca JOIN addons a ON a.id = ca.addon_id WHERE ca.contract_id = c.id) addons
      FROM contracts c JOIN plan_versions pv ON pv.id = c.plan_version_id JOIN plans p ON p.id = pv.plan_id WHERE c.status = 'ACTIVE'`);
    const byTenant = new Map(rows.map((r) => [r.tenant_id, r]));
    return (await this.placements.list()).map((t) => {
      const c = byTenant.get(t.id);
      return {
        id: t.id, slug: t.slug, status: t.status,
        plan: c ? { code: c.code, name: c.name, version: c.version, versionStatus: c.version_status, internal: c.internal } : null,
        addons: c?.addons ?? [], since: c?.starts_at ?? null,
        overrides: c ? Object.keys(c.overrides?.modules ?? {}).length + Object.keys(c.overrides?.features ?? {}).length : 0,
      };
    }).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** Module states as entitlement-service sees them (activating, read-only, last hook error), for support. */
  async moduleStates(tenantId: string) {
    const base = process.env.SVC_URL_ENTITLEMENT ?? 'http://localhost:4403';
    const res = await fetch(`${base}/internal/tenants/${tenantId}/module-states`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(5000) }).catch(() => null);
    return res?.ok ? ((await res.json()) as unknown[]) : null;
  }

  async auditLog(q: { targetType?: string; targetId?: string; limit: number }) {
    const { rows } = await this.db.query(`SELECT id, at, actor, action, target_type, target_id, target_label, before, after, note FROM platform_audit
      WHERE ($1::text IS NULL OR target_type = $1) AND ($2::text IS NULL OR target_id = $2) ORDER BY id DESC LIMIT $3`, [q.targetType ?? null, q.targetId ?? null, q.limit]);
    return rows.map((r) => ({ id: Number(r.id), at: r.at, actor: r.actor, action: r.action, target: { type: r.target_type, id: r.target_id, label: r.target_label }, before: r.before, after: r.after, note: r.note }));
  }
}
