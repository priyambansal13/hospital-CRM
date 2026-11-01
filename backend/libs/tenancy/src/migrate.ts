import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { serviceDbConfig, survive } from './db.js';

/**
 * Infra tables every service schema gets (control schema and tenant schema alike):
 * migration ledger, transactional outbox, consumer dedupe.
 */
export const INFRA_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  key text NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS processed_events (
  consumer text NOT NULL, event_id uuid NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
`;

export interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return { version: f.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    });
}

/**
 * Apply pending migrations to one database, inside the service's own schema. Expand/contract rule: a migration
 * must keep the previous release working (docs/MULTI-TENANCY.md §3.4). Applied files must never change.
 * Returns the latest applied version.
 */
export async function runMigrations(client: pg.ClientBase, schema: string, files: MigrationFile[]): Promise<string> {
  await client.query(`SET search_path TO ${schema}`);
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [`migrate:${schema}`]);
  try {
    await client.query(INFRA_TABLES_SQL);
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const m of files) {
      const prev = applied.get(m.version);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`migration ${schema}/${m.version} changed after it was applied (checksum ${prev} → ${m.checksum})`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [m.version, m.checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${schema}/${m.version} failed: ${(e as Error).message}`);
      }
    }
    return files.at(-1)?.version ?? 'none';
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`migrate:${schema}`]);
  }
}

/** Where to connect for migrations: a server's direct address (not the pooler). Defaults to this process's settings. */
export interface DirectServer { directHost: string; directPort: number }
const defaultServer = (): DirectServer => ({
  directHost: process.env.PG_HOST_DIRECT ?? process.env.PG_HOST ?? 'localhost',
  directPort: Number(process.env.PG_PORT_DIRECT ?? process.env.PG_PORT ?? 61432),
});

async function migrateDb(database: string, schema: string, files: MigrationFile[], server: DirectServer = defaultServer()) {
  const cfg = serviceDbConfig(schema);
  // Migrations connect to Postgres DIRECTLY (PG_HOST_DIRECT), not through PgBouncer: they use session-level advisory locks.
  const client = new pg.Client({
    host: server.directHost,
    port: server.directPort,
    database,
    user: cfg.user,
    password: cfg.password,
    application_name: `migrate:${schema}`,
  });
  survive(client, `migrate:${schema}`);
  await client.connect();
  try {
    return await runMigrations(client, schema, files);
  } finally {
    await client.end();
  }
}

export interface PlanTenant { id: string; slug: string; dbName: string; ring: number; server: string }
export interface PlanServer extends DirectServer { id: string; kind: 'SHARED' | 'DEDICATED'; maintenanceWindow: string | null }

/**
 * Release rings (docs/MULTI-TENANCY.md §3.4): 0 internal/test hospitals → 1 pilots → 2 everyone else → 3 dedicated
 * servers. Within a ring, batches of `size`; a batch never holds more than `perServer` hospitals of one server, so a
 * busy server is not hit by a whole batch at once. A ring above `maxRing` is left for later (still compatible:
 * migrations are expand/contract).
 */
export function planRings(tenants: PlanTenant[], o: { size?: number; perServer?: number; maxRing?: number } = {}): PlanTenant[][][] {
  const size = o.size ?? 10;
  const perServer = o.perServer ?? 4;
  const rings: PlanTenant[][][] = [];
  for (let ring = 0; ring <= Math.min(3, o.maxRing ?? 3); ring++) {
    const queue = tenants.filter((t) => t.ring === ring);
    const batches: PlanTenant[][] = [];
    while (queue.length) {
      const batch: PlanTenant[] = [];
      const used = new Map<string, number>();
      for (let i = 0; i < queue.length && batch.length < size;) {
        const t = queue[i];
        if ((used.get(t.server) ?? 0) < perServer) {
          batch.push(t);
          used.set(t.server, (used.get(t.server) ?? 0) + 1);
          queue.splice(i, 1);
        } else i++;
      }
      batches.push(batch);
    }
    rings.push(batches);
  }
  return rings;
}

/**
 * Entry point for each service's dist/migrate.js, driven by the platform migration orchestrator (`mc migrate`):
 *   migrate.js control            → mc_control, schema <schema>        (migrations/control)
 *   migrate.js template           → medicare_template                  (migrations/tenant)
 *   migrate.js tenants t_a,t_b    → each tenant DB; prints {"t_a": "0003_x", ...}
 *   migrate.js all                → control + template + every tenant DB (tenant list from tenant-service), versions
 *                                   reported back to the catalog. Used by the Kubernetes pre-upgrade Job.
 */
export async function migrateCli(opts: { schema: string; migrationsDir: string; argv?: string[] }) {
  const [target, list] = opts.argv ?? process.argv.slice(2);
  const control = loadMigrations(join(opts.migrationsDir, 'control'));
  const tenant = loadMigrations(join(opts.migrationsDir, 'tenant'));
  if (target === 'control') {
    console.log(await migrateDb(process.env.CONTROL_DB ?? 'mc_control', opts.schema, control));
  } else if (target === 'template') {
    console.log(await migrateDb(process.env.TEMPLATE_DB ?? 'medicare_template', opts.schema, tenant));
  } else if (target === 'tenants') {
    const out: Record<string, string> = {};
    for (const db of (list ?? '').split(',').filter(Boolean)) out[db] = await migrateDb(db, opts.schema, tenant);
    console.log(JSON.stringify(out));
  } else if (target === 'all') {
    await migrateAll(opts.schema, control, tenant);
  } else {
    throw new Error('usage: migrate.js control | template | tenants <db,db,...> | all');
  }
}

/**
 * In-cluster orchestrator for one service: control → every server's template → hospitals ring by ring (planRings),
 * versions reported to the catalog. The first failure stops the run: the remaining hospitals stay on the previous
 * (compatible) version and the Job fails, which alerts. Ring 3 (dedicated servers) only with MIGRATE_MAX_RING=3, which
 * the maintenance-window Job sets.
 */
async function migrateAll(schema: string, control: MigrationFile[], tenant: MigrationFile[]) {
  const base = process.env.SVC_URL_TENANT ?? 'http://localhost:4401';
  const headers = { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '', 'content-type': 'application/json' };
  if (control.length) console.log(`control: ${await migrateDb(process.env.CONTROL_DB ?? 'mc_control', schema, control)}`);
  if (!tenant.length) return;
  const template = process.env.TEMPLATE_DB ?? 'medicare_template';
  if (schema === 'tenant' && !(await fetch(`${base}/health`).then((r) => r.ok, () => false))) {
    console.log(`template: ${await migrateDb(template, schema, tenant)}`);
    console.log('tenant-service not reachable yet (first install): tenant databases are migrated on its next rollout');
    return;
  }
  const res = await fetch(`${base}/internal/migration-plan`, { headers });
  if (!res.ok) throw new Error(`tenant-service /internal/migration-plan → ${res.status}`);
  const plan = (await res.json()) as { servers: PlanServer[]; tenants: PlanTenant[] };
  const servers = new Map(plan.servers.map((s) => [s.id, s]));
  for (const s of plan.servers) console.log(`template on ${s.id}: ${await migrateDb(template, schema, tenant, s)}`);
  const rings = planRings(plan.tenants, { maxRing: Number(process.env.MIGRATE_MAX_RING ?? 2) });
  for (const [ring, batches] of rings.entries()) {
    for (const batch of batches) {
      await Promise.all(batch.map(async (t) => {
        const version = await migrateDb(t.dbName, schema, tenant, servers.get(t.server));
        await fetch(`${base}/internal/tenants/${t.id}/schema-versions/${schema}`, { method: 'PUT', headers, body: JSON.stringify({ version }) });
        console.log(`ring ${ring} ${t.slug}: ${version}`);
      }));
    }
  }
  const held = plan.tenants.filter((t) => t.ring > Number(process.env.MIGRATE_MAX_RING ?? 2)).length;
  if (held) console.log(`${held} hospital(s) in later rings wait for their maintenance window`);
}
