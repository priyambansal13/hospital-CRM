import { loadCatalog } from '@mc/entitlements-sdk/catalog';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeEntitlements, type PlanOption, upsellOptions } from './compute.js';
import { loadPlanCatalog, validateVersion } from './plan-catalog.js';

const modules = loadCatalog();
const seed = loadPlanCatalog(modules);
const version = (code: string) => {
  const p = seed.plans.find((x) => x.code === code)!;
  const v = p.versions.at(-1)!;
  return { code: p.code, name: p.name, version: v.version, listPrice: v.listPrice, modules: v.modules, features: v.features, settings: v.settings, addonCodes: v.addons } satisfies PlanOption & { settings: unknown };
};
const addons = seed.addons.map((a) => ({ code: a.code, name: a.name, module: a.module ?? null, feature: a.feature ?? null, extraLimit: a.extraLimit ?? null, listPrice: a.listPrice }));
const addon = (code: string, quantity = 1) => ({ ...addons.find((a) => a.code === code)!, quantity });

describe('plan catalogue', () => {
  it('the real modules/plans.yaml is valid against the manifests', () => {
    expect(seed.plans.map((p) => p.code)).toContain('HOSPITAL_PRO');
  });

  it('rejects a plan missing a dependency, a limit on a BOOLEAN feature and unknown add-ons', () => {
    const d = mkdtempSync(join(tmpdir(), 'plans-'));
    writeFileSync(join(d, 'plans.yaml'), `editions: [{ code: CLINIC, name: Clinic }]
addons: []
plans:
  - code: BROKEN
    name: Broken
    edition: CLINIC
    tier: Starter
    versions:
      - { version: 1, listPrice: 1, modules: [core, home_collection], features: { core.custom_roles: { limit: 3 } }, addons: [NOPE] }
`);
    expect(() => loadPlanCatalog(modules, join(d, 'plans.yaml'))).toThrow(/Home sample collection needs Diagnostics and lab[\s\S]*cannot have a limit[\s\S]*unknown add-on NOPE/);
  });

  it('only internal plans may contain internal modules (the platform console)', () => {
    const v = { listPrice: 1, modules: ['core', 'platform'], features: {}, settings: {}, addons: [] };
    expect(validateVersion(modules, v, new Map())).toContain('platform is internal to MediCare and cannot be sold');
    expect(validateVersion(modules, v, new Map(), { internal: true })).toEqual([]);
    expect(seed.plans.find((p) => p.code === 'MEDICARE_HQ')?.internal).toBe(true);
  });

  it('setting bounds must stay inside the manifest range; a module add-on the plan already has is refused', () => {
    const v = { listPrice: 1, modules: ['core', 'diagnostics'], features: {}, settings: { 'diagnostics.max_advance_days': { min: 0, max: 400 } }, addons: ['LAB'] };
    const p = validateVersion(modules, v, new Map([['LAB', { module: 'diagnostics' }]]));
    expect(p.join('; ')).toMatch(/min below 1[\s\S]*max above 90[\s\S]*already includes/);
  });
});

describe('computeEntitlements', () => {
  it('Clinic Starter: no lab, 1 branch, custom roles off', () => {
    const e = computeEntitlements(modules, version('CLINIC_STARTER'), []);
    expect(e.problems).toEqual([]);
    expect(e.modules.map((m) => m.key)).not.toContain('diagnostics');
    expect(e.features['core.branches']).toEqual({ enabled: true, limit: 1, overage: null });
    // v2: a monthly SMS allowance; beyond it each SMS is billed
    expect(e.features['core.sms']).toEqual({ enabled: true, limit: 2000, overage: 'ALLOW_BILL' });
    expect(e.features['core.custom_roles'].enabled).toBe(false);
    expect(e.features['diagnostics.packages']).toBeUndefined();
  });

  it('add-ons add modules and raise limits; overrides win', () => {
    const e = computeEntitlements(modules, version('CLINIC_PRO'), [addon('LAB'), addon('BRANCHES_5', 2)], { features: { 'directory.doctors': { limit: 75 } } });
    expect(e.modules.find((m) => m.key === 'diagnostics')).toEqual({ key: 'diagnostics', source: 'ADDON' });
    expect(e.features['core.branches'].limit).toBe(3 + 10);
    expect(e.features['directory.doctors'].limit).toBe(75);
    expect(e.settingBounds['diagnostics.max_advance_days']).toEqual({ min: 1, max: 90, allowed: null });
  });

  it('an override that breaks a dependency is a problem; always-on modules stay', () => {
    const e = computeEntitlements(modules, version('HOSPITAL_PRO'), [], { modules: { diagnostics: false, core: false } });
    expect(e.problems).toContain('home_collection needs diagnostics');
    expect(e.modules.map((m) => m.key)).toContain('core');
  });

  it('plan setting bounds narrow the manifest range', () => {
    expect(computeEntitlements(modules, version('DIAGNOSTIC_STARTER'), []).settingBounds['diagnostics.max_advance_days']).toEqual({ min: 1, max: 14, allowed: null });
  });
});

describe('upsellOptions', () => {
  const plans = seed.plans.map((p) => version(p.code));
  const on = (code: string, extra: ReturnType<typeof addon>[] = []) => {
    const plan = version(code);
    return { plan, effective: computeEntitlements(modules, plan, extra), addons: extra };
  };

  it('a clinic on Starter wanting the lab: a plan that keeps its clinic modules (not a diagnostic-center plan)', () => {
    const o = upsellOptions(modules, on('CLINIC_STARTER'), { module: 'diagnostics' }, plans, addons);
    expect(o[0]).toMatchObject({ kind: 'PLAN', code: 'HOSPITAL_PRO' });
    expect(o.map((x) => x.code)).not.toContain('DIAGNOSTIC_STARTER');
  });

  it('on Clinic Professional the lab add-on is cheaper than upgrading', () => {
    const o = upsellOptions(modules, on('CLINIC_PRO'), { module: 'diagnostics' }, plans, addons);
    expect(o[0]).toMatchObject({ kind: 'ADDON', code: 'LAB', monthlyTotal: 9999 + 5999 });
  });

  it('home collection needs diagnostics first: no add-on offered without it', () => {
    const o = upsellOptions(modules, on('CLINIC_PRO'), { module: 'home_collection' }, plans, addons);
    expect(o.every((x) => x.kind === 'PLAN')).toBe(true);
  });

  it('a limit: a quota add-on or a plan with a higher limit', () => {
    const o = upsellOptions(modules, on('CLINIC_STARTER'), { module: 'core', feature: 'core.branches' }, plans, addons);
    expect(o[0]).toMatchObject({ kind: 'ADDON', code: 'BRANCHES_5' });
    expect(o.some((x) => x.code === 'CLINIC_PRO')).toBe(true);
  });
});
