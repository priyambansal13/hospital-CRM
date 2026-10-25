import type { TenantPlacement } from '@mc/contracts';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { HttpPlacementSource, loadMigrations, NoTenantContextError, runMigrations, serviceDbConfig, TenantContext, TenantDbRouter, TenantRoutingError, type PlacementSource } from '../src/index.js';

const placements = new HttpPlacementSource();
const routers: TenantDbRouter[] = [];
afterAll(async () => { await Promise.all(routers.map((r) => r.close())); });

describe('TenantDbRouter', () => {
  it('routes each tenant to its own database', async () => {
    const [a, b] = await Promise.all([placements.resolveHost('citycare.localhost'), placements.resolveHost('sunrise.localhost')]);
    const router = new TenantDbRouter(placements, 'tenant');
    routers.push(router);
    const da = await (await router.forTenant(a.id)).query('SELECT current_database() db, (SELECT tenant_id FROM public.tenant_meta) t');
    const db = await (await router.forTenant(b.id)).query('SELECT current_database() db, (SELECT tenant_id FROM public.tenant_meta) t');
    expect(da.rows[0]).toEqual({ db: 't_citycare', t: a.id });
    expect(db.rows[0]).toEqual({ db: 't_sunrise', t: b.id });
  });

  it('refuses a database whose tenant_meta belongs to another tenant (mis-routing guard)', async () => {
    const a = await placements.resolveHost('citycare.localhost');
    const b = await placements.resolveHost('sunrise.localhost');
    // a broken catalog entry: tenant A pointing at tenant B's database
    const broken: PlacementSource = { get: async () => ({ ...a, dbName: b.dbName }) as TenantPlacement, resolveHost: async () => a, list: async () => [a] };
    const router = new TenantDbRouter(broken, 'tenant');
    routers.push(router);
    await expect(router.forTenant(a.id)).rejects.toBeInstanceOf(TenantRoutingError);
  });

  it('tenant-scoped code cannot run without a tenant in context', async () => {
    const router = new TenantDbRouter(placements, 'tenant');
    routers.push(router);
    await expect(router.query('SELECT 1')).rejects.toBeInstanceOf(NoTenantContextError);
    const a = await placements.resolveHost('citycare.localhost');
    const r = await TenantContext.run(a, () => router.query('SELECT current_database() db'));
    expect(r.rows[0].db).toBe('t_citycare');
  });
});

describe('runMigrations', () => {
  it('applies once, is idempotent, and rejects edited migrations', async () => {
    const cfg = serviceDbConfig('tenant');
    const conn = { host: process.env.PG_HOST, port: Number(process.env.PG_PORT), user: cfg.user, password: cfg.password };
    const scratch = `mc_test_${Date.now()}`;
    const admin = new pg.Client({ ...conn, database: 'mc_control' });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratch}`);
    const c = new pg.Client({ ...conn, database: scratch });
    await c.connect();
    try {
      await c.query('CREATE SCHEMA demo');
      const files = [{ version: '0001_a', sql: 'CREATE TABLE things (id int)', checksum: 'aaa' }];
      expect(await runMigrations(c, 'demo', files)).toBe('0001_a');
      expect(await runMigrations(c, 'demo', files)).toBe('0001_a');
      await expect(runMigrations(c, 'demo', [{ ...files[0], checksum: 'bbb' }])).rejects.toThrow(/changed after it was applied/);
      expect(loadMigrations('/nonexistent')).toEqual([]);
    } finally {
      await c.end();
      await admin.query(`DROP DATABASE ${scratch}`);
      await admin.end();
    }
  });
});
