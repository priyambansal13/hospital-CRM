import { type Catalog, missingDependencies, modulesDir } from '@mc/entitlements-sdk/catalog';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const Code = z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/);

export const Overage = z.enum(['BLOCK', 'SOFT_WARN', 'ALLOW_BILL']);
export type Overage = z.infer<typeof Overage>;
const FeatureValue = z.object({ enabled: z.boolean().default(true), limit: z.number().int().min(0).nullable().default(null), overage: Overage.optional() });

/** In the file a version may say `from: 1` and only list what changes (features are merged). */
const PlanVersionFile = z.object({
  version: z.number().int().positive(),
  from: z.number().int().positive().optional(),
  listPrice: z.number().min(0).optional(),
  trialDays: z.number().int().min(0).optional(),
  modules: z.array(z.string()).min(1).optional(),
  features: z.record(z.string(), FeatureValue).default({}),
  settings: z.record(z.string(), z.object({ min: z.number().optional(), max: z.number().optional(), allowed: z.array(z.string()).optional() })).optional(),
  addons: z.array(Code).optional(),
});
const PlanVersionSeed = z.object({
  version: z.number().int().positive(),
  listPrice: z.number().min(0),
  trialDays: z.number().int().min(0).default(0),
  modules: z.array(z.string()).min(1),
  features: z.record(z.string(), FeatureValue).default({}),
  settings: z.record(z.string(), z.object({ min: z.number().optional(), max: z.number().optional(), allowed: z.array(z.string()).optional() })).default({}),
  addons: z.array(Code).default([]),
});

export const PlanCatalogSeed = z.object({
  editions: z.array(z.object({ code: Code, name: z.string(), description: z.string().optional() })),
  addons: z.array(z.object({
    code: Code, name: z.string(), listPrice: z.number().min(0),
    module: z.string().optional(), feature: z.string().optional(), extraLimit: z.number().int().positive().optional(),
  }).refine((a) => !!a.module !== !!(a.feature && a.extraLimit), 'an add-on is a module, or a feature + extraLimit')),
  plans: z.array(z.object({ code: Code, name: z.string(), edition: Code, tier: z.string(), internal: z.boolean().default(false), versions: z.array(PlanVersionFile).min(1) })),
}).transform((cat) => ({
  ...cat,
  plans: cat.plans.map((p) => {
    const done: z.infer<typeof PlanVersionSeed>[] = [];
    for (const v of p.versions) {
      const base = v.from ? done.find((x) => x.version === v.from) : undefined;
      if (v.from && !base) throw new Error(`${p.code} v${v.version}: from v${v.from}, which is not listed before it`);
      done.push(PlanVersionSeed.parse({
        version: v.version,
        listPrice: v.listPrice ?? base?.listPrice,
        trialDays: v.trialDays ?? base?.trialDays ?? 0,
        modules: v.modules ?? base?.modules,
        features: { ...base?.features, ...v.features },
        settings: v.settings ?? base?.settings ?? {},
        addons: v.addons ?? base?.addons ?? [],
      }));
    }
    return { ...p, versions: done };
  }),
}));
export type PlanCatalogSeed = z.infer<typeof PlanCatalogSeed>;
export type PlanVersionSeed = z.infer<typeof PlanVersionSeed>;

export function plansFile() {
  return join(modulesDir(), 'plans.yaml');
}

/** What a plan version contains (seed file or a draft in the plan builder). */
export interface VersionDraft {
  listPrice: number;
  trialDays?: number;
  modules: string[];
  features: Record<string, { enabled: boolean; limit: number | null; overage?: Overage | null }>;
  settings: Record<string, { min?: number | null; max?: number | null; allowed?: string[] | null }>;
  addons: string[];
}

/**
 * Check a plan version against the module manifests: modules exist and bring their dependencies, always-on modules
 * are in, internal modules only in internal plans, features/settings belong to an included module, limits only on
 * LIMIT features, settings within the manifest's range, add-ons exist. Returns every problem (empty = valid).
 */
export function validateVersion(modules: Catalog, v: VersionDraft, knownAddons: Map<string, { module?: string | null }>, opts: { internal?: boolean } = {}): string[] {
  const problems: string[] = [];
  const features = new Map([...modules.modules.values()].flatMap((m) => m.features.map((f) => [f.key, { ...f, module: m.key }] as const)));
  const settings = new Map([...modules.modules.values()].flatMap((m) => m.settings.map((x) => [x.key, { ...x, module: m.key }] as const)));
  const mods = new Set(v.modules);
  if (v.listPrice < 0) problems.push('price cannot be negative');
  for (const k of mods) {
    const m = modules.modules.get(k);
    if (!m) problems.push(`unknown module ${k}`);
    else if (m.internal && !opts.internal) problems.push(`${k} is internal to MediCare and cannot be sold`);
  }
  for (const m of modules.modules.values()) if (m.alwaysOn && !mods.has(m.key)) problems.push(`must include ${m.name} (always on)`);
  for (const d of missingDependencies(modules, mods)) problems.push(`${modules.modules.get(d.module)?.name ?? d.module} needs ${modules.modules.get(d.needs)?.name ?? d.needs}`);
  for (const [k, f] of Object.entries(v.features)) {
    const def = features.get(k);
    if (!def) problems.push(`unknown feature ${k}`);
    else if (!mods.has(def.module)) problems.push(`feature ${def.name} belongs to ${def.module}, which the plan does not include`);
    else if (f.limit != null && def.type === 'BOOLEAN') problems.push(`${def.name} is ${def.type}, it cannot have a limit`);
    else if (f.overage && def.type !== 'METERED') problems.push(`${def.name} is not metered: no overage rule`);
    else if (f.limit != null && f.limit < 0) problems.push(`${def.name}: limit cannot be negative`);
  }
  for (const [k, b] of Object.entries(v.settings)) {
    const def = settings.get(k);
    if (!def?.planBounded) problems.push(`${k} is not a plan-bounded setting`);
    else if (!mods.has(def.module)) problems.push(`setting ${k} belongs to ${def.module}, which the plan does not include`);
    else {
      if (b.min != null && b.max != null && b.min > b.max) problems.push(`${def.name}: min > max`);
      if (b.min != null && def.min != null && b.min < def.min) problems.push(`${def.name}: min below ${def.min}`);
      if (b.max != null && def.max != null && b.max > def.max) problems.push(`${def.name}: max above ${def.max}`);
    }
  }
  for (const a of v.addons) {
    const x = knownAddons.get(a);
    if (!x) problems.push(`unknown add-on ${a}`);
    else if (x.module && mods.has(x.module)) problems.push(`add-on ${a} gives ${x.module}, which the plan already includes`);
  }
  return problems;
}

/** Load the seed catalogue and validate every plan version. Throws listing every problem. */
export function loadPlanCatalog(modules: Catalog, file = plansFile()): PlanCatalogSeed {
  const seed = PlanCatalogSeed.parse(parseYaml(readFileSync(file, 'utf8')));
  const problems: string[] = [];
  const editions = new Set(seed.editions.map((e) => e.code));
  const addons = new Map(seed.addons.map((a) => [a.code, a]));
  const features = new Map([...modules.modules.values()].flatMap((m) => m.features.map((f) => [f.key, { ...f, module: m.key }] as const)));
  for (const a of seed.addons) {
    if (a.module && !modules.modules.has(a.module)) problems.push(`add-on ${a.code}: unknown module ${a.module}`);
    if (a.module && modules.modules.get(a.module)?.internal) problems.push(`add-on ${a.code}: ${a.module} is internal`);
    if (a.feature && features.get(a.feature)?.type !== 'LIMIT') problems.push(`add-on ${a.code}: ${a.feature} is not a LIMIT feature`);
  }
  for (const p of seed.plans) {
    if (!editions.has(p.edition)) problems.push(`${p.code}: unknown edition ${p.edition}`);
    for (const v of p.versions) for (const x of validateVersion(modules, v, addons, { internal: p.internal })) problems.push(`${p.code} v${v.version}: ${x}`);
  }
  if (problems.length) throw new Error(`invalid plan catalogue ${file}:\n - ${problems.join('\n - ')}`);
  return seed;
}
