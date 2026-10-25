import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * The module catalogue (docs/PRODUCT-MODULES-AND-PLANS.md §2.1): developer-owned manifests in backend/modules, read by
 * entitlement-service (registry, roles, capabilities) and subscription-service (which plans can contain what).
 */
const PermissionCode = z.string().regex(/^[a-z_]+:[a-z_]+:(own|tenant|branch|treating|public)$/, 'resource:action:scope');
const Zone = z.enum(['shell', 'admin', 'patient', 'doctor', 'desk', 'lab', 'account', 'platform']);

export const Manifest = z.object({
  key: z.string().regex(/^[a-z_]+$/),
  name: z.string(),
  version: z.number().int().positive(),
  alwaysOn: z.boolean().default(false),
  /** MediCare's own (platform console): never in a sold plan, never listed or upsold */
  internal: z.boolean().default(false),
  dependsOn: z.array(z.string()).default([]),
  services: z.array(z.string()).default([]),
  permissions: z.array(z.object({ code: PermissionCode, description: z.string() })).default([]),
  /** BOOLEAN: on/off per plan; LIMIT: a count the plan caps (null = unlimited); METERED: usage per period (Phase 19) */
  features: z.array(z.object({ key: z.string(), name: z.string(), type: z.enum(['BOOLEAN', 'LIMIT', 'METERED']), unit: z.string().optional(), default: z.boolean().default(true) })).default([]),
  /** hospital-editable settings; a plan may bound planBounded ones (min/max or allowed values) */
  settings: z.array(z.object({
    key: z.string(), name: z.string(), type: z.enum(['int', 'enum', 'bool']), default: z.union([z.number(), z.string(), z.boolean()]),
    values: z.array(z.string()).optional(), min: z.number().optional(), max: z.number().optional(), planBounded: z.boolean().default(false),
  })).default([]),
  /** services (by schema) whose internal/tenants/:t/modules/:key/enable|disable hook runs when the module is switched on/off */
  lifecycle: z.array(z.string()).default([]),
  /** a nav item shows when the user has ALL listed permissions (zone access = at least one nav item in the zone) */
  nav: z.array(z.object({ key: z.string(), label: z.string(), zone: Zone, href: z.string().startsWith('/'), permissions: z.array(PermissionCode).default([]), audience: z.enum(['any', 'staff', 'patient']).default('any') })).default([]),
  defaultRoleGrants: z.record(z.string(), z.array(PermissionCode)).default({}),
});
export type Manifest = z.infer<typeof Manifest>;

export const RoleTemplates = z.object({
  roles: z.array(z.object({ code: z.string().regex(/^[A-Z_]{3,40}$/), name: z.string(), grantsAll: z.boolean().default(false), patient: z.boolean().default(false), home: z.string().default('/') })),
});
export type RoleTemplate = z.infer<typeof RoleTemplates>['roles'][number];

export interface Catalog {
  modules: Map<string, Manifest>;
  roles: RoleTemplate[];
  permissionModule: Map<string, string>;
}

export function modulesDir() {
  return process.env.MODULES_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../../modules');
}

/** Load + validate every manifest. Throws with all problems listed (used at startup and by CI). */
export function loadCatalog(dir = modulesDir()): Catalog {
  if (!existsSync(dir)) throw new Error(`modules dir not found: ${dir}`);
  const problems: string[] = [];
  const modules = new Map<string, Manifest>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.module.yaml')).sort()) {
    const r = Manifest.safeParse(parseYaml(readFileSync(join(dir, f), 'utf8')));
    if (!r.success) { problems.push(`${f}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`); continue; }
    if (`${r.data.key}.module.yaml` !== f) problems.push(`${f}: key ${r.data.key} must match file name`);
    modules.set(r.data.key, r.data);
  }
  const roles = RoleTemplates.parse(parseYaml(readFileSync(join(dir, 'roles.yaml'), 'utf8'))).roles;
  const roleCodes = new Set(roles.map((r) => r.code));
  const permissionModule = new Map<string, string>();
  for (const m of modules.values()) {
    for (const d of m.dependsOn) if (!modules.has(d)) problems.push(`${m.key}: depends on unknown module ${d}`);
    for (const f of m.features) if (!f.key.startsWith(`${m.key}.`)) problems.push(`${m.key}: feature ${f.key} must start with "${m.key}."`);
    for (const st of m.settings) {
      if (!st.key.startsWith(`${m.key}.`)) problems.push(`${m.key}: setting ${st.key} must start with "${m.key}."`);
      if (st.type === 'enum' && !st.values?.includes(String(st.default))) problems.push(`${m.key}: setting ${st.key} default must be one of its values`);
      if (st.type === 'int' && typeof st.default !== 'number') problems.push(`${m.key}: setting ${st.key} default must be a number`);
    }
    for (const p of m.permissions) {
      if (permissionModule.has(p.code)) problems.push(`${m.key}: permission ${p.code} already declared by ${permissionModule.get(p.code)}`);
      permissionModule.set(p.code, m.key);
    }
  }
  for (const m of modules.values()) {
    for (const n of m.nav) for (const p of n.permissions) if (!permissionModule.has(p)) problems.push(`${m.key}: nav ${n.key} uses undeclared permission ${p}`);
    for (const [role, perms] of Object.entries(m.defaultRoleGrants)) {
      if (!roleCodes.has(role)) problems.push(`${m.key}: grants to unknown role ${role}`);
      for (const p of perms) if (!permissionModule.has(p)) problems.push(`${m.key}: grants undeclared permission ${p}`);
    }
  }
  // dependency cycles
  const visiting = new Set<string>();
  const visit = (k: string, path: string[]) => {
    if (visiting.has(k)) { problems.push(`dependency cycle: ${[...path, k].join(' → ')}`); return; }
    visiting.add(k);
    for (const d of modules.get(k)?.dependsOn ?? []) visit(d, [...path, k]);
    visiting.delete(k);
  };
  for (const k of modules.keys()) visit(k, []);
  if (problems.length) throw new Error(`invalid module manifests:\n - ${problems.join('\n - ')}`);
  return { modules, roles, permissionModule };
}

/** A module that is no longer in the plan stays readable: only its "read" permissions remain (records stay viewable). */
export const isReadPermission = (code: string) => code.split(':')[1] === 'read';

/** Modules a set needs but doesn't contain (dependencies are "all of"). */
export function missingDependencies(catalog: Catalog, keys: Iterable<string>): { module: string; needs: string }[] {
  const set = new Set(keys);
  const out: { module: string; needs: string }[] = [];
  for (const k of set) for (const d of catalog.modules.get(k)?.dependsOn ?? []) if (!set.has(d)) out.push({ module: k, needs: d });
  return out;
}

/** Default permissions for a role template across the given modules. */
export function templateGrants(catalog: Catalog, roleCode: string, moduleKeys: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const k of moduleKeys) for (const p of catalog.modules.get(k)?.defaultRoleGrants[roleCode] ?? []) out.add(p);
  return [...out];
}
