import type { ContractChanged } from '@mc/contracts';
import { type Catalog, missingDependencies } from '@mc/entitlements-sdk/catalog';

export interface PlanVersionDef {
  modules: string[];
  features: Record<string, { enabled: boolean; limit: number | null; overage?: 'BLOCK' | 'SOFT_WARN' | 'ALLOW_BILL' | null }>;
  settings: Record<string, { min?: number | null; max?: number | null; allowed?: string[] | null }>;
}
export interface AddonDef { code: string; name: string; module: string | null; feature: string | null; extraLimit: number | null; quantity: number }
export interface Overrides {
  /** true = switched on outside the plan, false = switched off although the plan has it */
  modules?: Record<string, boolean>;
  features?: Record<string, { enabled?: boolean; limit?: number | null; overage?: 'BLOCK' | 'SOFT_WARN' | 'ALLOW_BILL' | null }>;
}

export type Effective = Pick<ContractChanged, 'modules' | 'features' | 'settingBounds'>;

/**
 * A contract = plan version + add-ons + overrides (docs/PRODUCT-MODULES-AND-PLANS.md §6). Returns the hospital's
 * effective modules (with where each comes from), feature switches/limits and setting bounds, plus dependency problems
 * (a contract with problems must not be saved).
 */
export function computeEntitlements(catalog: Catalog, plan: PlanVersionDef, addons: AddonDef[], overrides: Overrides = {}): Effective & { problems: string[] } {
  const source = new Map<string, ContractChanged['modules'][number]['source']>();
  for (const k of plan.modules) source.set(k, 'PLAN');
  for (const a of addons) if (a.module && !source.has(a.module)) source.set(a.module, 'ADDON');
  for (const [k, on] of Object.entries(overrides.modules ?? {})) {
    if (on && !source.has(k)) source.set(k, 'OVERRIDE');
    if (!on) source.delete(k);
  }
  const problems: string[] = [];
  for (const m of catalog.modules.values()) {
    if (m.alwaysOn && !source.has(m.key)) source.set(m.key, 'PLAN');
  }
  for (const k of source.keys()) if (!catalog.modules.has(k)) problems.push(`unknown module ${k}`);
  for (const d of missingDependencies(catalog, source.keys())) problems.push(`${d.module} needs ${d.needs}`);

  const features: Effective['features'] = {};
  const settingBounds: Effective['settingBounds'] = {};
  for (const key of source.keys()) {
    const m = catalog.modules.get(key);
    if (!m) continue;
    for (const f of m.features) {
      // a feature the plan doesn't mention: on unless its manifest says it is off by default (e.g. custom domain)
      const p = plan.features[f.key] ?? { enabled: f.default, limit: null };
      let limit = f.type === 'BOOLEAN' ? null : p.limit;
      // a quota add-on raises a limit (an unlimited limit stays unlimited)
      for (const a of addons) if (a.feature === f.key && a.extraLimit && limit != null) limit += a.extraLimit * a.quantity;
      const o = overrides.features?.[f.key];
      const finalLimit = o && 'limit' in o ? (o.limit ?? null) : limit;
      // metered: beyond the limit, BLOCK unless the plan says to warn or bill
      const overage = f.type !== 'METERED' ? null : (o?.overage ?? p.overage ?? (finalLimit == null ? null : 'BLOCK'));
      features[f.key] = { enabled: o?.enabled ?? p.enabled, limit: finalLimit, overage };
    }
    for (const s of m.settings) {
      const b = plan.settings[s.key];
      if (!s.planBounded) continue;
      settingBounds[s.key] = { min: b?.min ?? s.min ?? null, max: b?.max ?? s.max ?? null, allowed: b?.allowed ?? s.values ?? null };
    }
  }
  const order = [...catalog.modules.keys()];
  const modules = [...source.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([key, src]) => ({ key, source: src }));
  return { modules, features, settingBounds, problems };
}

export interface PlanOption { code: string; name: string; version: number; listPrice: number; modules: string[]; features: PlanVersionDef['features']; addonCodes: string[] }
export interface AddonOption { code: string; name: string; module: string | null; feature: string | null; extraLimit: number | null; listPrice: number }
export interface UpsellOption { kind: 'ADDON' | 'PLAN'; code: string; name: string; price: number; monthlyTotal: number }

/**
 * The cheapest ways to unlock a module or feature (for <Upsell>): an add-on allowed on the current plan, or another
 * plan that keeps every module the hospital has now. A LIMIT feature counts as unlocked when its limit is higher.
 */
export function upsellOptions(
  catalog: Catalog,
  current: { plan: PlanOption; effective: Effective; addons: AddonDef[] },
  target: { module: string; feature?: string },
  plans: PlanOption[],
  addons: AddonOption[],
): UpsellOption[] {
  const have = new Set(current.effective.modules.map((m) => m.key));
  const feature = target.feature;
  const currentLimit = feature ? current.effective.features[feature]?.limit : undefined;
  const better = (enabled: boolean, limit: number | null | undefined) =>
    enabled && (currentLimit == null || limit == null || limit > currentLimit);
  const base = current.plan.listPrice + current.addons.reduce((s, a) => s + (addons.find((x) => x.code === a.code)?.listPrice ?? 0) * a.quantity, 0);
  const out: UpsellOption[] = [];

  for (const a of addons.filter((x) => current.plan.addonCodes.includes(x.code))) {
    if (a.module === target.module && !have.has(a.module)) {
      if (missingDependencies(catalog, [...have, a.module]).length) continue;
      out.push({ kind: 'ADDON', code: a.code, name: a.name, price: a.listPrice, monthlyTotal: base + a.listPrice });
    } else if (feature && a.feature === feature && have.has(target.module) && currentLimit != null) {
      out.push({ kind: 'ADDON', code: a.code, name: a.name, price: a.listPrice, monthlyTotal: base + a.listPrice });
    }
  }
  for (const p of plans) {
    if (p.code === current.plan.code) continue;
    if (![...have, target.module].every((m) => p.modules.includes(m))) continue;
    if (feature) {
      const def = [...catalog.modules.values()].flatMap((m) => m.features).find((x) => x.key === feature);
      const f = p.features[feature] ?? { enabled: def?.default ?? true, limit: null };
      if (!better(f.enabled, f.limit)) continue;
    }
    out.push({ kind: 'PLAN', code: p.code, name: p.name, price: p.listPrice, monthlyTotal: p.listPrice });
  }
  return out.sort((a, b) => a.monthlyTotal - b.monthlyTotal).slice(0, 3);
}
