/**
 * @mc/entitlements-sdk: "can this actor do this, in this hospital, right now?" for every service
 * (docs/FEATURES-AND-PLANS.md §5). Capabilities come from entitlement-service, cached briefly per (tenant, actor) and
 * evicted immediately when entitlement-service publishes entitlements_changed.
 */
import { applyDecorators, type CanActivate, type ExecutionContext, Global, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Capabilities, EventTypes, Topics } from '@mc/contracts';
import { createConsumer } from '@mc/kafka';
import { appendRequires, DomainError, notFound, REDIS, type Redis, REQUIRES, verifyActor } from '@mc/nest-common';
import { RequestContext } from '@mc/tenancy';
import { LRUCache } from 'lru-cache';
import { randomUUID } from 'node:crypto';

@Injectable()
export class EntitlementsClient {
  private readonly cache = new LRUCache<string, Capabilities>({ max: 20_000, ttl: Number(process.env.ENTITLEMENTS_CACHE_MS ?? 30_000) });
  private readonly modules = new LRUCache<string, TenantModules>({ max: 5_000, ttl: Number(process.env.ENTITLEMENTS_CACHE_MS ?? 30_000) });
  private readonly settings = new LRUCache<string, Record<string, unknown>>({ max: 5_000, ttl: Number(process.env.ENTITLEMENTS_CACHE_MS ?? 30_000) });
  private readonly features = new LRUCache<string, TenantFeatures>({ max: 5_000, ttl: Number(process.env.ENTITLEMENTS_CACHE_MS ?? 30_000) });
  private readonly base = process.env.SVC_URL_ENTITLEMENT ?? 'http://localhost:4403';

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(this.base + path, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' } });
    if (!res.ok) throw new DomainError(503, 'ENTITLEMENTS_UNAVAILABLE', `entitlement-service ${res.status}`);
    return (await res.json()) as T;
  }

  async capabilities(tenantId: string, actor: { id: string; kind: string }): Promise<Capabilities> {
    const key = `${tenantId}:${actor.id}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const caps = await this.fetchJson<Capabilities>(`/internal/capabilities/${tenantId}/${actor.id}?kind=${actor.kind}`);
    this.cache.set(key, caps);
    return caps;
  }

  async tenantModules(tenantId: string): Promise<TenantModules> {
    const hit = this.modules.get(tenantId);
    if (hit) return hit;
    const r = await this.fetchJson<TenantModules>(`/internal/tenants/${tenantId}/modules`);
    this.modules.set(tenantId, r);
    return r;
  }

  /**
   * For background jobs ("start/stop jobs per hospital"): ACTIVE = run, READ_ONLY = data kept but nothing new,
   * OFF = not bought (or still activating).
   */
  async moduleState(tenantId: string, module: string): Promise<'ACTIVE' | 'READ_ONLY' | 'OFF'> {
    const m = await this.tenantModules(tenantId);
    return m.modules.includes(module) ? 'ACTIVE' : m.readOnly.includes(module) ? 'READ_ONLY' : 'OFF';
  }

  /** Effective features of a hospital (limits, overage rules) without an actor: for metering in background work. */
  async tenantFeatures(tenantId: string): Promise<TenantFeatures> {
    const hit = this.features.get(tenantId);
    if (hit) return hit;
    const r = await this.fetchJson<TenantFeatures>(`/internal/tenants/${tenantId}/features`);
    this.features.set(tenantId, r);
    return r;
  }

  /** The hospital's settings (effective values within its plan's bounds): key → value. */
  async tenantSettings(tenantId: string): Promise<Record<string, unknown>> {
    const hit = this.settings.get(tenantId);
    if (hit) return hit;
    const { settings } = await this.fetchJson<{ settings: Record<string, unknown> }>(`/internal/tenants/${tenantId}/settings`);
    this.settings.set(tenantId, settings);
    return settings;
  }

  /** One setting, or the fallback if it is not set / entitlement-service is unreachable (never blocks the caller). */
  async setting<T>(tenantId: string, key: string, fallback: T): Promise<T> {
    const all: Record<string, unknown> = await this.tenantSettings(tenantId).catch(() => ({}));
    return (all[key] as T | undefined) ?? fallback;
  }

  invalidate(tenantId: string, userId?: string | null) {
    this.modules.delete(tenantId);
    this.features.delete(tenantId);
    this.settings.delete(tenantId);
    if (userId) this.cache.delete(`${tenantId}:${userId}`);
    else for (const k of this.cache.keys()) if (k.startsWith(`${tenantId}:`)) this.cache.delete(k);
  }
}

export interface TenantModules { modules: string[]; readOnly: string[] }
export interface TenantFeatures { features: Record<string, { enabled: boolean; limit: number | null; overage: 'BLOCK' | 'SOFT_WARN' | 'ALLOW_BILL' | null }>; billingStatus: string }

/** Live usage counter in Redis: usage:<tenant>:<feature>:<YYYY-MM> (calendar month, UTC); all keys listed in usage:keys. */
export const usageMonth = (d = new Date()) => d.toISOString().slice(0, 7);
export const usageKey = (tenantId: string, feature: string, month = usageMonth()) => `usage:${tenantId}:${feature}:${month}`;
export const USAGE_KEYS = 'usage:keys';

// check-and-increment in one step (docs/FEATURES-AND-PLANS.md §5.3): over the limit with BLOCK → undone, refused
const RESERVE = `
local used = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], 5184000)
redis.call('SADD', KEYS[2], KEYS[1])
local limit = tonumber(ARGV[2])
if limit >= 0 and ARGV[3] == 'BLOCK' and ARGV[4] ~= 'force' and used > limit then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return {0, used - tonumber(ARGV[1])}
end
return {1, used}`;

export interface Reservation { allowed: boolean; used: number; limit: number | null; overage: string | null; over: boolean }

/**
 * Usage metering for METERED features (SMS, later AI messages, video minutes): reserve before doing the work, release
 * if it fails. BLOCK refuses beyond the limit; SOFT_WARN and ALLOW_BILL allow (ALLOW_BILL is invoiced as overage).
 * `force` counts without refusing (e.g. login codes must always go out).
 */
@Injectable()
export class UsageMeter {
  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly client: EntitlementsClient) {}

  async reserve(tenantId: string, feature: string, qty = 1, opts: { force?: boolean } = {}): Promise<Reservation> {
    const f = (await this.client.tenantFeatures(tenantId)).features[feature];
    const limit = f?.limit ?? null;
    const overage = f?.overage ?? null;
    const [ok, used] = (await this.redis.eval(RESERVE, 2, usageKey(tenantId, feature), USAGE_KEYS, String(qty), String(limit ?? -1), overage ?? 'NONE', opts.force ? 'force' : '')) as [number, number];
    return { allowed: ok === 1, used, limit, overage, over: limit != null && used > limit };
  }

  /** The work failed: give the units back. */
  async release(tenantId: string, feature: string, qty = 1) {
    await this.redis.decrby(usageKey(tenantId, feature), qty);
  }

  async used(tenantId: string, feature: string, month = usageMonth()) {
    return Number((await this.redis.get(usageKey(tenantId, feature, month))) ?? 0);
  }
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A module the hospital no longer has stays readable (records stay viewable for care); anything else is refused. */
function checkModule(m: string, active: string[], readOnly: string[], method: string) {
  if (active.includes(m)) return;
  if (readOnly.includes(m)) {
    if (READS.has(method)) return;
    throw new DomainError(403, 'MODULE_READ_ONLY', `module ${m} is no longer in this hospital's plan: existing data can be viewed, nothing new can be added`, { module: m, upgradeUrl: '/admin/plan' });
  }
  throw moduleError(m);
}

/** Checks the route's "module:/feature:/permission:" requirements against the actor's capabilities. */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly client: EntitlementsClient) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const requires = this.reflector.getAllAndMerge<string[]>(REQUIRES, [ctx.getHandler(), ctx.getClass()]) ?? [];
    if (!requires.length) return true;
    const rc = RequestContext.current();
    if (!rc?.tenant) throw new DomainError(500, 'TENANT_ROUTING', 'entitlement check without tenant');
    const need = (prefix: string) => requires.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));

    const method = String(ctx.switchToHttp().getRequest<{ method?: string }>().method ?? 'GET').toUpperCase();
    // a public route called with a valid token for this hospital (staff screens reuse public lists): treat as signed in
    const req = ctx.switchToHttp().getRequest<{ headers?: Record<string, string | undefined> }>();
    const viewer = rc.actor ?? (req.headers?.authorization ? await verifyActor(req.headers.authorization, rc.tenant).catch(() => undefined) : undefined);
    if (!viewer) {
      // signed out (catalogue, slots, pincode check): only modules in full use. A read-only module's records are for
      // the signed-in patients and staff they belong to.
      const t = await this.client.tenantModules(rc.tenant.id);
      for (const m of need('module:')) checkModule(m, t.modules, [], method);
      if (need('permission:').length || need('feature:').length) throw new DomainError(401, 'UNAUTHENTICATED', 'sign in required');
      return true;
    }
    const caps = await this.client.capabilities(rc.tenant.id, viewer);
    for (const m of need('module:')) checkModule(m, caps.modules, caps.readOnlyModules ?? [], method);
    if (!rc.actor) return true; // public route with a token: only the module check applies
    for (const f of need('feature:')) if (!caps.features[f]?.enabled) throw new DomainError(403, 'FEATURE_NOT_IN_PLAN', `feature ${f} is not available on this hospital's plan`, { feature: f, upgradeUrl: '/admin/plan' });
    for (const p of need('permission:')) if (!caps.permissions.includes(p)) throw new DomainError(403, 'PERMISSION_DENIED', `missing permission ${p}`, { permission: p });
    // a branch named in the request must be one the permission was granted for (review B-1). Records looked up by id
    // are checked by the service (assertInBranch), which knows the record's branch.
    const r = ctx.switchToHttp().getRequest<{ query?: Record<string, unknown>; params?: Record<string, unknown>; body?: unknown }>();
    const named = [r.params?.branchId, r.query?.branchId, (r.body as { branchId?: unknown } | undefined)?.branchId].filter((b): b is string => typeof b === 'string' && b.length > 0);
    for (const p of need('permission:')) for (const b of named) if (!inBranch(caps, p, b)) throw outsideBranch(p);
    return true;
  }
}

/** The branches a ":branch" permission covers for this person: null = every branch, [] = not held at all. */
export function branchesFor(caps: Capabilities, permission: string): string[] | null {
  if (!caps.permissions.includes(permission)) return [];
  return caps.branchScopes?.[permission] ?? null;
}

/** Does the person hold the permission at this branch? (A record without a branch needs the hospital-wide grant.) */
export function inBranch(caps: Capabilities, permission: string, branchId: string | null | undefined): boolean {
  const b = branchesFor(caps, permission);
  return b === null || (!!branchId && b.includes(branchId));
}

const outsideBranch = (permission: string) => new DomainError(403, 'OUTSIDE_BRANCH', 'you work at other branches: this belongs to a branch you have no access to', { permission });

/**
 * For records found by id: refuse one at a branch the person does not work at. `hide` answers "not found" (the default:
 * the record's existence is not revealed); otherwise 403 OUTSIDE_BRANCH.
 */
export function assertInBranch(caps: Capabilities, permission: string, branchId: string | null | undefined, what = 'record', hide = true) {
  if (inBranch(caps, permission, branchId)) return;
  if (hide) throw notFound(what);
  throw outsideBranch(permission);
}

/** SQL helper: `branch_col = ANY($n)` when the permission is branch-limited, otherwise no condition. */
export function branchFilter(caps: Capabilities, permission: string, column: string, param: number): { sql: string; args: unknown[] } {
  const b = branchesFor(caps, permission);
  return b === null ? { sql: '', args: [] } : { sql: ` AND ${column} = ANY($${param})`, args: [b] };
}

const moduleError = (m: string) => new DomainError(403, 'MODULE_NOT_IN_PLAN', `module ${m} is not active for this hospital`, { module: m, upgradeUrl: '/admin/plan' });

export const RequirePermission = (...permissions: string[]) => applyDecorators(appendRequires(...permissions.map((p) => `permission:${p}`)), UseGuards(EntitlementGuard));
export const RequireFeature = (...features: string[]) => applyDecorators(appendRequires(...features.map((f) => `feature:${f}`)), UseGuards(EntitlementGuard));
/**
 * A LIMIT feature (e.g. core.branches): refuse to create one more when the hospital already has `current` and its
 * plan allows `limit`. null/undefined limit = unlimited.
 */
export function assertWithinLimit(caps: Capabilities, feature: string, current: number) {
  const limit = caps.features[feature]?.limit;
  if (limit == null || current < limit) return;
  throw new DomainError(422, 'PLAN_LIMIT_REACHED', `this hospital's plan allows ${limit} (${feature}); upgrade the plan to add more`, { feature, limit, upgradeUrl: '/admin/plan' });
}

export const RequireModule = (...modules: string[]) => applyDecorators(appendRequires(...modules.map((m) => `module:${m}`)), UseGuards(EntitlementGuard));

/** Evicts cached capabilities as soon as entitlement-service publishes a change (one consumer group per instance). */
@Injectable()
class InvalidationListener implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Entitlements');
  private consumer?: { disconnect(): Promise<void> };
  constructor(private readonly client: EntitlementsClient) {}

  async onApplicationBootstrap() {
    if (process.env.MC_DISABLE_EVENTS === 'true') return;
    this.consumer = await createConsumer(`${process.env.SERVICE_NAME}-entinv`, `${process.env.SERVICE_NAME}-entinv-${randomUUID()}`, [Topics.entitlement], async (m) => {
      const evt = JSON.parse(m.value ?? '{}');
      if (evt.type === EventTypes.entitlementsChanged && evt.tenantId) this.client.invalidate(evt.tenantId, evt.data?.userId);
    }, { fromBeginning: false }).catch((e) => {
      this.log.warn(`invalidation listener not started: ${(e as Error).message}`);
      return undefined;
    });
  }
  async onApplicationShutdown() {
    await this.consumer?.disconnect().catch(() => undefined);
  }
}

@Global()
@Module({ providers: [EntitlementsClient, EntitlementGuard, InvalidationListener, UsageMeter], exports: [EntitlementsClient, EntitlementGuard, UsageMeter] })
export class EntitlementsModule {}
