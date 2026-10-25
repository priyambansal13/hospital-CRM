import type { TenantPlacement } from '@mc/contracts';
import { LRUCache } from 'lru-cache';
import pg from 'pg';
import { TenantContext } from './context.js';
import { serviceDbConfig, survive, withTx } from './db.js';
import type { PlacementSource } from './placement.js';

export class TenantRoutingError extends Error {
  constructor(tenantId: string, dbName: string, found: string | undefined) {
    super(`database ${dbName} belongs to ${found ?? 'nobody'}, not tenant ${tenantId}: refusing to use it`);
  }
}
export class TenantUnavailableError extends Error {
  constructor(public readonly tenantId: string, public readonly status: string) {
    super(`tenant ${tenantId} is ${status}`);
  }
}

/**
 * Picks the tenant's own database (docs/MULTI-TENANCY.md §3.2). One small pool per active tenant, closed when
 * idle or evicted. Every new pool is verified against public.tenant_meta before first use, so a wrong catalog
 * entry fails loudly instead of reading another hospital's data.
 */
export class TenantDbRouter {
  private readonly pools: LRUCache<string, Promise<pg.Pool>>;
  private readonly cfg: ReturnType<typeof serviceDbConfig>;

  constructor(
    private readonly placements: PlacementSource,
    schema: string,
    private readonly opts: { maxPerTenant?: number; maxTenants?: number } = {},
  ) {
    this.cfg = serviceDbConfig(schema);
    this.pools = new LRUCache({
      max: opts.maxTenants ?? 300,
      dispose: (p) => void p.then((pool) => pool.end()).catch(() => undefined),
    });
  }

  async forTenant(tenantId: string): Promise<pg.Pool> {
    const cached = this.pools.get(tenantId);
    if (cached) return cached;
    const created = this.open(tenantId);
    this.pools.set(tenantId, created);
    created.catch(() => this.pools.delete(tenantId));
    return created;
  }

  /** Pool for the tenant in the current request/event context. */
  current(): Promise<pg.Pool> {
    return this.forTenant(TenantContext.require().id);
  }

  /** Transaction on the current tenant's database. */
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTx(await this.current(), fn);
  }

  async query<R extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
    return (await this.current()).query<R>(sql, params);
  }

  /** Drop a tenant's pool (placement changed, tenant moved or suspended). */
  evict(tenantId: string) {
    this.pools.delete(tenantId);
  }

  async close() {
    const all = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(all.map(async (p) => (await p).end()));
  }

  private async open(tenantId: string): Promise<pg.Pool> {
    const t: TenantPlacement = await this.placements.get(tenantId);
    if (t.status !== 'ACTIVE' && t.status !== 'READ_ONLY') throw new TenantUnavailableError(tenantId, t.status);
    const pool = new pg.Pool({
      host: t.dbHost,
      port: t.dbPort,
      database: t.dbName,
      user: this.cfg.user,
      password: this.cfg.password,
      max: this.opts.maxPerTenant ?? 5,
      idleTimeoutMillis: 60_000,
      application_name: `${this.cfg.user}:${t.slug}`,
    });
    survive(pool, `tenant:${t.slug}`); // idle client errors: logged, the next query reconnects
    const { rows } = await pool.query<{ tenant_id: string }>('SELECT tenant_id FROM public.tenant_meta LIMIT 1');
    if (rows[0]?.tenant_id !== tenantId) {
      await pool.end();
      throw new TenantRoutingError(tenantId, t.dbName, rows[0]?.tenant_id);
    }
    return pool;
  }
}
