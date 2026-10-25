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

async function migrateDb(database: string, schema: string, files: MigrationFile[]) {
  const cfg = serviceDbConfig(schema);
  // Migrations connect to Postgres DIRECTLY (PG_HOST_DIRECT), not through PgBouncer: they use session-level advisory locks.
  const client = new pg.Client({
    host: process.env.PG_HOST_DIRECT ?? process.env.PG_HOST ?? 'localhost',
    port: Number(process.env.PG_PORT_DIRECT ?? process.env.PG_PORT ?? 61432),
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

/** In-cluster orchestrator for one service: control → template → tenant DBs in batches of 10, report versions. */
async function migrateAll(schema: string, control: MigrationFile[], tenant: MigrationFile[]) {
  const base = process.env.SVC_URL_TENANT ?? 'http://localhost:4401';
  const headers = { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '', 'content-type': 'application/json' };
  if (control.length) console.log(`control: ${await migrateDb(process.env.CONTROL_DB ?? 'mc_control', schema, control)}`);
  if (!tenant.length) return;
  console.log(`template: ${await migrateDb(process.env.TEMPLATE_DB ?? 'medicare_template', schema, tenant)}`);
  if (schema === 'tenant' && !(await fetch(`${base}/health`).then((r) => r.ok, () => false))) {
    console.log('tenant-service not reachable yet (first install): tenant databases are migrated on its next rollout');
    return;
  }
  const res = await fetch(`${base}/internal/tenants`, { headers });
  if (!res.ok) throw new Error(`tenant-service /internal/tenants → ${res.status}`);
  const tenants = ((await res.json()) as { id: string; slug: string; dbName: string; status: string }[]).filter((t) => ['ACTIVE', 'READ_ONLY', 'PROVISIONING'].includes(t.status));
  for (let i = 0; i < tenants.length; i += 10) {
    await Promise.all(tenants.slice(i, i + 10).map(async (t) => {
      const version = await migrateDb(t.dbName, schema, tenant);
      await fetch(`${base}/internal/tenants/${t.id}/schema-versions/${schema}`, { method: 'PUT', headers, body: JSON.stringify({ version }) });
      console.log(`${t.slug}: ${version}`);
    }));
  }
}
