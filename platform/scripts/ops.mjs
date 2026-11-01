// Production-readiness operations (Phase 30): database servers, moving a hospital between servers, release rings,
// per-hospital backups and restore drills. Used by mc.mjs; the same steps run as Kubernetes Jobs in production
// (MC_PG_MODE=direct: psql/pg_dump/pg_restore connect to each server's direct address instead of `docker compose exec`).
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Local servers: the compose service behind each direct port. */
const LOCAL = { 61432: 'postgres', 61433: 'postgres-b' };

export function makeOps(ctx) {
  const { log, fail, env, api, svcUrl, lit, ident, PLATFORM, composeArgs } = ctx;
  const tenantApi = (path, opts) => api(svcUrl('tenant'), path, opts);

  // ---------- running psql / pg_dump / pg_restore on a server
  function run(server, bin, args, { input, binary = false } = {}) {
    const opts = { input, maxBuffer: 1 << 30, encoding: binary ? undefined : 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
    try {
      if (process.env.MC_PG_MODE === 'direct') {
        return execFileSync(bin, ['-h', server.directHost, '-p', String(server.directPort), '-U', 'postgres', ...args], { ...opts, env: { ...process.env, PGHOST: server.directHost, PGPORT: String(server.directPort), PGUSER: 'postgres', PGPASSWORD: env().POSTGRES_PASSWORD } });
      }
      const svc = LOCAL[server.directPort] ?? fail(`server ${server.id}: no local container for port ${server.directPort} (set MC_PG_MODE=direct)`);
      return execFileSync('docker', [...composeArgs(), 'exec', '-T', svc, bin, '-U', 'postgres', ...args], opts);
    } catch (e) {
      throw new Error(`${server.id} ${bin}: ${String(e.stderr ?? e.message).trim().split('\n').slice(-3).join(' | ')}`);
    }
  }
  const sql = (server, db, text) => run(server, 'psql', ['-v', 'ON_ERROR_STOP=1', '-qAt', '-d', db], { input: text });
  const rows = (server, db, text) => sql(server, db, text).split('\n').filter(Boolean).map((l) => l.split('|'));

  const servers = async () => tenantApi('/internal/db-servers');
  const svcRoles = (server) => rows(server, 'postgres', `SELECT quote_ident(rolname) FROM pg_roles WHERE rolname LIKE 'svc\\_%' ORDER BY 1`).map((r) => r[0]);
  const serverById = async (id) => (await servers()).find((s) => s.id === id) ?? fail(`no database server ${id} (mc server list)`);
  const tenantBySlug = async (slug) => (await tenantApi('/internal/tenants')).find((t) => t.slug === slug) ?? fail(`no hospital ${slug}`);

  /** Every user table of a hospital database (all service schemas and public), as schema.table. */
  const tablesOf = (server, db) => rows(server, db, `SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1`).map((r) => r[0]);
  const q = (name) => name.split('.').map((p) => `"${p.replaceAll('"', '""')}"`).join('.');
  const countsSql = (tables) => tables.length
    ? `SELECT json_object_agg(t, n) FROM (${tables.map((t) => `SELECT ${lit(t)} t, count(*) n FROM ${q(t)}`).join(' UNION ALL ')}) x`
    : `SELECT '{}'::json`;
  const versionsSql = (server, db) => {
    const schemas = rows(server, db, `SELECT table_schema FROM information_schema.tables WHERE table_name = 'schema_migrations' ORDER BY 1`).map((r) => r[0]);
    return schemas.length ? `SELECT json_object_agg(s, v) FROM (${schemas.map((s) => `SELECT ${lit(s)} s, max(version) v FROM ${q(`${s}.schema_migrations`)}`).join(' UNION ALL ')}) x` : `SELECT '{}'::json`;
  };

  // ---------- servers
  /** Roles, the template database and schemas on one server (the control database lives on the first server only). */
  function bootstrapServer(server, svcs, passwords) {
    let s = 'SET client_min_messages TO warning;\n';
    for (const x of svcs) {
      const role = `svc_${ident(x.schema)}`;
      s += `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${lit(role)}) THEN CREATE ROLE ${role} LOGIN PASSWORD ${lit(passwords[x.schema])}; ELSE ALTER ROLE ${role} PASSWORD ${lit(passwords[x.schema])}; END IF; END $$;\n`;
      s += `ALTER ROLE ${role} SET search_path TO ${x.schema}, public;\n`;
    }
    s += 'ALTER ROLE svc_tenant CREATEDB;\n';
    // copies a hospital to another server (logical replication); reads everything, writes nothing
    s += `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mc_replicator') THEN CREATE ROLE mc_replicator LOGIN REPLICATION PASSWORD ${lit(env().REPLICATION_PASSWORD ?? fail('REPLICATION_PASSWORD missing: run mc configure'))}; ELSE ALTER ROLE mc_replicator PASSWORD ${lit(env().REPLICATION_PASSWORD)}; END IF; END $$;\n`;
    s += 'GRANT pg_read_all_data TO mc_replicator;\n';
    s += `SELECT 'CREATE DATABASE medicare_template' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'medicare_template')\\gexec\n`;
    sql(server, 'postgres', s);
    const tenantSchemas = svcs.filter((x) => x.tenant).map((x) => `CREATE SCHEMA IF NOT EXISTS ${x.schema} AUTHORIZATION svc_${x.schema};`).join('\n');
    // datallowconn: a retired copy left behind by a move is not touched
    const dbs = rows(server, 'postgres', `SELECT datname FROM pg_database WHERE datname LIKE 't\\_%' AND datallowconn`).map((r) => r[0]);
    for (const db of ['medicare_template', ...dbs]) {
      sql(server, db, `SET client_min_messages TO warning;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE TABLE IF NOT EXISTS public.tenant_meta (tenant_id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_meta OWNER TO svc_tenant;
GRANT SELECT ON public.tenant_meta TO PUBLIC;
${tenantSchemas}\n`);
    }
    sql(server, 'postgres', 'ALTER DATABASE medicare_template IS_TEMPLATE true;');
    return dbs.length;
  }

  const hostPort = (v, what) => {
    const m = /^([^:]+):(\d+)$/.exec(String(v ?? ''));
    if (!m) fail(`--${what} host:port`);
    return [m[1], Number(m[2])];
  };

  async function serverAdd(id, f, { svcs, passwords, migrateTemplate }) {
    const [pooledHost, pooledPort] = hostPort(f.pooled, 'pooled');
    const [directHost, directPort] = hostPort(f.direct, 'direct');
    const [peerHost, peerPort] = hostPort(f.peer, 'peer');
    const s = await tenantApi(`/internal/db-servers/${id}`, { method: 'PUT', body: {
      pooledHost, pooledPort, directHost, directPort, peerHost, peerPort, kind: f.kind ?? 'SHARED', status: f.status ?? 'OPEN',
      capacity: Number(f.capacity ?? 500), region: f.region ?? 'in-1', maintenanceWindow: f.window ?? null,
    } });
    const n = bootstrapServer(s, svcs, passwords);
    migrateTemplate(s);
    log(`server ${id} (${s.kind}): roles, template and schemas ready${n ? ` (${n} hospital database(s))` : ''}`);
    return s;
  }

  // ---------- backups
  const unwrapKey = (wrapped) => {
    const [v, iv, tag, ct] = wrapped.split('.');
    if (v !== 'v1') fail('unknown backup key format');
    const d = createDecipheriv('aes-256-gcm', Buffer.from(env().BACKUP_MASTER_KEY, 'base64url'), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  };
  const wrapKey = (key) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', Buffer.from(env().BACKUP_MASTER_KEY ?? fail('BACKUP_MASTER_KEY missing: run mc configure'), 'base64url'), iv);
    const ct = Buffer.concat([c.update(key), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  };
  async function backupKey(t) {
    const got = await fetch(`${svcUrl('tenant')}/internal/tenants/${t.id}/backup-key`, { headers: { 'x-internal-token': env().INTERNAL_API_TOKEN } });
    if (got.ok) return unwrapKey((await got.json()).wrapped);
    if (got.status !== 404) fail(`backup key: ${got.status}`);
    // first backup of this hospital; a concurrent first backup keeps whichever key was stored first
    const stored = await tenantApi(`/internal/tenants/${t.id}/backup-key`, { method: 'PUT', body: { wrapped: wrapKey(randomBytes(32)) } });
    return unwrapKey(stored.wrapped);
  }
  const backupDir = () => process.env.MC_BACKUP_DIR ?? join(PLATFORM, 'backups');

  /**
   * One hospital's backup: pg_dump inside a REPEATABLE READ transaction whose snapshot it shares, so the row counts
   * and schema versions recorded with it describe exactly what the dump holds. Encrypted (AES-256-GCM) with the
   * hospital's backup key; the catalog keeps where it is, its checksum, counts and versions.
   */
  async function backupOne(t, kind = 'MANUAL') {
    const server = await serverById(t.dbServer);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const tables = tablesOf(server, t.dbName);
    const tmp = `/tmp/mc-backup-${id}.dump`;
    const out = sql(server, t.dbName, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot() AS snap \\gset
\\setenv MC_SNAP :snap
\\! pg_dump -U postgres -Fc --snapshot="$MC_SNAP" -f ${tmp} ${ident(t.dbName)}
SELECT 'COUNTS ' || (${countsSql(tables)})::text;
SELECT 'VERSIONS ' || (${versionsSql(server, t.dbName)})::text;
COMMIT;\n`);
    const counts = JSON.parse(/^COUNTS (.*)$/m.exec(out)?.[1] ?? fail(`backup of ${t.slug}: no counts (${out.slice(0, 200)})`));
    const versions = JSON.parse(/^VERSIONS (.*)$/m.exec(out)?.[1] ?? '{}');
    const dump = process.env.MC_PG_MODE === 'direct' ? readFileSync(tmp) : execFileSync('docker', [...composeArgs(), 'exec', '-T', LOCAL[server.directPort], 'cat', tmp], { maxBuffer: 1 << 30 });
    if (process.env.MC_PG_MODE === 'direct') execFileSync('rm', ['-f', tmp]);
    else execFileSync('docker', [...composeArgs(), 'exec', '-T', LOCAL[server.directPort], 'rm', '-f', tmp]);
    if (!dump.length) fail(`backup of ${t.slug}: empty dump`);
    const key = await backupKey(t);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(`${t.id}:${id}`));
    const body = Buffer.concat([Buffer.from('MCBK1'), iv, c.update(dump), c.final(), c.getAuthTag()]);
    const dir = join(backupDir(), t.slug);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${startedAt.slice(0, 19).replace(/[:T]/g, '-')}-${id.slice(0, 8)}.mcbk`);
    writeFileSync(file, body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    await tenantApi(`/internal/tenants/${t.id}/backups`, { method: 'POST', body: {
      id, serverId: server.id, kind, location: file, bytes: body.length, sha256, tables: counts, versions, startedAt, finishedAt: new Date().toISOString(),
    } });
    const rowsTotal = Object.values(counts).reduce((a, b) => a + Number(b), 0);
    log(`${t.slug}: backup ${id.slice(0, 8)} (${kind}) ${(body.length / 1e6).toFixed(2)} MB, ${tables.length} tables, ${rowsTotal} rows → ${file}`);
    return { id, file, counts, versions, sha256 };
  }

  /**
   * Restore drill: decrypt and check the backup, restore it into a scratch database on the hospital's server, and
   * compare it with what was recorded at backup time (the hospital's id, every table's row count, schema versions).
   * The time taken is this hospital's restore time (RTO); the backup's age is how much would be lost (RPO).
   */
  async function drill(t, backupId, { keep = false } = {}) {
    const list = await tenantApi(`/internal/tenants/${t.id}/backups`);
    const b = backupId ? list.find((x) => x.id.startsWith(backupId)) : list[0];
    if (!b) { console.error(`[mc] ${t.slug}: no backup${backupId ? ` ${backupId}` : ''} to drill (mc backup run ${t.slug})`); return { ok: false, problems: ['no backup'] }; }
    const server = await serverById(t.dbServer);
    const t0 = Date.now();
    const report = { backupId: b.id, backupAgeMinutes: Math.round((Date.now() - Date.parse(b.started_at)) / 60000), problems: [] };
    let restoredDb;
    try {
      if (!existsSync(b.location)) throw new Error(`backup file missing: ${b.location}`);
      const body = readFileSync(b.location);
      if (createHash('sha256').update(body).digest('hex') !== b.sha256) throw new Error('checksum does not match the catalog');
      if (body.subarray(0, 5).toString() !== 'MCBK1') throw new Error('not a MediCare backup');
      const key = await backupKey(t);
      const d = createDecipheriv('aes-256-gcm', key, body.subarray(5, 17));
      d.setAAD(Buffer.from(`${t.id}:${b.id}`));
      d.setAuthTag(body.subarray(body.length - 16));
      const dump = Buffer.concat([d.update(body.subarray(17, body.length - 16)), d.final()]);
      restoredDb = `drill_${t.dbName.slice(2)}_${Date.now().toString(36)}`.slice(0, 63);
      sql(server, 'postgres', `CREATE DATABASE ${ident(restoredDb)};`);
      run(server, 'pg_restore', ['--exit-on-error', '-d', restoredDb], { input: dump });
      const meta = rows(server, restoredDb, 'SELECT tenant_id FROM public.tenant_meta')[0]?.[0];
      if (meta !== t.id) report.problems.push(`tenant_meta is ${meta}, expected ${t.id}`);
      const want = b.tables;
      const got = JSON.parse(sql(server, restoredDb, countsSql(Object.keys(want))).trim() || '{}');
      for (const [table, n] of Object.entries(want)) if (Number(got[table]) !== Number(n)) report.problems.push(`${table}: ${got[table]} rows restored, ${n} backed up`);
      const versions = JSON.parse(sql(server, restoredDb, versionsSql(server, restoredDb)).trim() || '{}');
      for (const [schema, v] of Object.entries(b.versions)) if (versions[schema] !== v) report.problems.push(`${schema}: version ${versions[schema]} restored, ${v} backed up`);
      report.tables = Object.keys(want).length;
      report.rows = Object.values(want).reduce((a, x) => a + Number(x), 0);
    } catch (e) {
      report.problems.push(e.message);
    } finally {
      // the scratch copy only (named drill_*; created above); --keep leaves it for a look
      if (restoredDb && !keep && /^drill_[a-z0-9_]+$/.test(restoredDb)) {
        try { sql(server, 'postgres', `DROP DATABASE IF EXISTS ${restoredDb} WITH (FORCE);`); } catch (e) { report.problems.push(`clean-up: ${e.message}`); }
      }
    }
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    const ok = report.problems.length === 0;
    await tenantApi(`/internal/backups/${b.id}/drill`, { method: 'PATCH', body: { ok, seconds, report: { ...report, ...(keep && restoredDb ? { keptAs: restoredDb } : {}) } } });
    log(`${t.slug}: restore drill of ${b.id.slice(0, 8)} ${ok ? 'passed' : 'FAILED'} in ${seconds}s (backup ${report.backupAgeMinutes} min old${report.rows != null ? `, ${report.tables} tables, ${report.rows} rows` : ''})${ok ? '' : `\n  ${report.problems.join('\n  ')}`}`);
    return { ok, seconds, ...report };
  }

  // ---------- moving a hospital to another server
  /**
   * Logical replication (docs/MULTI-TENANCY.md §3.5): an empty copy of the database on the new server at the same
   * schema versions → copy and stream every change → READ_ONLY for a few seconds → fence the old copy (services can no
   * longer connect) → wait until the new copy has every change and the row counts match → sequences → switch the
   * catalog (services drop their pools on the event) → ACTIVE. The old copy is kept, renamed and closed to connections.
   */
  async function move(slug, toId, { migrateTemplate, timeoutMs = 600_000 } = {}) {
    const t = await tenantBySlug(slug);
    if (t.status !== 'ACTIVE') fail(`${slug} is ${t.status}: only an ACTIVE hospital can be moved`);
    const from = await serverById(t.dbServer);
    const to = await serverById(toId);
    if (from.id === to.id) fail(`${slug} is already on ${to.id}`);
    const db = ident(t.dbName);
    const sub = `mc_move_${db}`.slice(0, 63);
    const { id: moveId } = await tenantApi(`/internal/tenants/${t.id}/moves`, { method: 'POST', body: { from: from.id, to: to.id } });
    const began = Date.now();
    const step = (name, extra = {}) => { log(`${slug}: ${name} (${((Date.now() - began) / 1000).toFixed(1)}s)`); return tenantApi(`/internal/moves/${moveId}`, { method: 'PATCH', body: { step: name, ...extra } }); };
    let readOnlyAt;
    let switched = false;
    let created = false;
    try {
      await step('backup');
      await backupOne(t, 'PRE_MOVE');

      await step('prepare');
      migrateTemplate(to);
      if (rows(to, 'postgres', `SELECT 1 FROM pg_database WHERE datname = ${lit(db)}`).length) throw new Error(`${to.id} already has a database ${db}`);
      sql(to, 'postgres', `CREATE DATABASE ${db} TEMPLATE medicare_template;`);
      created = true;
      const srcVersions = JSON.parse(sql(from, db, versionsSql(from, db)).trim());
      const dstVersions = JSON.parse(sql(to, db, versionsSql(to, db)).trim());
      const differ = Object.keys(srcVersions).filter((s) => srcVersions[s] !== dstVersions[s]);
      if (differ.length) throw new Error(`schema versions differ on ${to.id} (${differ.map((s) => `${s} ${srcVersions[s]} vs ${dstVersions[s] ?? 'none'}`).join(', ')}): run mc migrate first`);
      // the template's own rows (seeded by migrations) come again from the hospital's copy
      const dstTables = tablesOf(to, db);
      sql(to, db, `SET session_replication_role = replica; TRUNCATE ${dstTables.map(q).join(', ')} CASCADE;`); // replica: append-only guards (audit) do not fire on this empty copy

      await step('copy');
      // tables without a primary key need the whole row to identify an update or delete, or the hospital's own
      // writes would fail while the publication exists
      sql(from, db, `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.oid::regclass AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema') AND c.relreplident = 'd'
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)
  LOOP EXECUTE format('ALTER TABLE %s REPLICA IDENTITY FULL', r.t); END LOOP; END $$;
DROP PUBLICATION IF EXISTS mc_move;
CREATE PUBLICATION mc_move FOR ALL TABLES;`);
      sql(to, db, `CREATE SUBSCRIPTION ${sub} CONNECTION ${lit(`host=${from.peerHost} port=${from.peerPort} dbname=${db} user=mc_replicator password=${env().REPLICATION_PASSWORD}`)} PUBLICATION mc_move WITH (slot_name = ${lit(sub)});`);
      const copyEnd = Date.now() + timeoutMs;
      for (;;) {
        const left = Number(sql(to, db, `SELECT count(*) FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid = r.srsubid WHERE s.subname = ${lit(sub)} AND r.srsubstate <> 'r'`).trim());
        if (left === 0) break;
        if (Date.now() > copyEnd) throw new Error(`initial copy not finished after ${timeoutMs / 1000}s (${left} tables left)`);
        await sleep(500);
      }

      await step('read_only');
      readOnlyAt = Date.now();
      await tenantApi(`/internal/tenants/${t.id}/status`, { method: 'PATCH', body: { status: 'READ_ONLY' } });
      await sleep(Number(process.env.MOVE_DRAIN_MS ?? 2000)); // requests in flight finish; services see READ_ONLY

      await step('fence');
      // every service role by name: the database's owner (svc_tenant, which created it) connects as owner, not
      // through PUBLIC, and would otherwise keep writing to the old copy
      sql(from, 'postgres', `REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC, ${svcRoles(from).join(', ')}; GRANT CONNECT ON DATABASE ${db} TO mc_replicator;
SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = ${lit(db)} AND usename LIKE 'svc\\_%';`);
      const leaks = sql(from, 'postgres', `SELECT string_agg(r.rolname, ',') FROM pg_roles r WHERE r.rolname LIKE 'svc\\_%' AND has_database_privilege(r.oid, ${lit(db)}, 'CONNECT')`).trim();
      if (leaks) throw new Error(`fence incomplete: ${leaks} can still connect to the old copy`);

      await step('catch_up');
      const lsn = sql(from, db, 'SELECT pg_current_wal_lsn()').trim();
      const tables = tablesOf(from, db);
      const end = Date.now() + 120_000;
      let diff = [];
      let srcCounts = {};
      for (;;) {
        const caught = sql(from, 'postgres', `SELECT coalesce(bool_and(confirmed_flush_lsn >= ${lit(lsn)}::pg_lsn), false) FROM pg_replication_slots WHERE slot_name = ${lit(sub)}`).trim() === 't';
        if (caught) {
          const a = (srcCounts = JSON.parse(sql(from, db, countsSql(tables)).trim()));
          const b = JSON.parse(sql(to, db, countsSql(tables)).trim());
          diff = tables.filter((x) => Number(a[x]) !== Number(b[x])).map((x) => `${x} ${a[x]}→${b[x]}`);
          if (!diff.length) break;
        }
        if (Date.now() > end) throw new Error(`new copy not caught up after 120s${diff.length ? `: ${diff.slice(0, 5).join(', ')}` : ''}`);
        await sleep(500);
      }

      // row counts cannot see an update: compare each table's content too (smaller tables; large ones by count only)
      const small = tables.filter((x) => Number(srcCounts[x]) <= 200_000);
      const sums = (server) => JSON.parse(sql(server, db, small.length
        ? `SELECT json_object_agg(t, h) FROM (${small.map((x) => `SELECT ${lit(x)} t, md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) h FROM ${q(x)} r`).join(' UNION ALL ')}) x`
        : `SELECT '{}'::json`).trim());
      const [sa, sb] = [sums(from), sums(to)];
      const changed = small.filter((x) => sa[x] !== sb[x]);
      if (changed.length) throw new Error(`content differs after catch-up: ${changed.slice(0, 5).join(', ')}`);

      await step('sequences');
      const seqs = rows(from, db, 'SELECT schemaname, sequencename, last_value FROM pg_sequences WHERE last_value IS NOT NULL');
      if (seqs.length) sql(to, db, seqs.map(([s, n, v]) => `SELECT setval(${lit(`${q(`${s}.${n}`)}`)}, ${Number(v)}, true);`).join('\n'));

      await step('switch');
      sql(to, db, `DROP SUBSCRIPTION ${sub};`); // also drops the replication slot on the old server
      await tenantApi(`/internal/tenants/${t.id}/placement`, { method: 'PUT', body: { server: to.id } });
      switched = true;
      await tenantApi(`/internal/tenants/${t.id}/status`, { method: 'PATCH', body: { status: 'ACTIVE' } });
      const readOnlyMs = Date.now() - readOnlyAt;

      await step('retire_old_copy', { readOnlyMs });
      const retired = `moved_${db}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`.slice(0, 63);
      sql(from, db, 'DROP PUBLICATION IF EXISTS mc_move;');
      sql(from, 'postgres', `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = ${lit(db)} AND pid <> pg_backend_pid();
ALTER DATABASE ${db} RENAME TO ${ident(retired)};
ALTER DATABASE ${retired} ALLOW_CONNECTIONS false;`);
      await step('done', { status: 'DONE', detail: { retiredCopy: `${from.id}/${retired}`, tables: tables.length } });
      log(`${slug}: moved ${from.id} → ${to.id}; read-only for ${(readOnlyMs / 1000).toFixed(1)}s; old copy kept as ${from.id}/${retired} (closed to connections)`);
      return { moveId, readOnlyMs, retired };
    } catch (e) {
      // before the switch the old copy is still the hospital's database: undo and reopen it
      if (!switched) {
        try { sql(to, db, `DROP SUBSCRIPTION IF EXISTS ${sub};`); } catch { /* the database may not exist */ }
        try { sql(from, 'postgres', `GRANT CONNECT ON DATABASE ${db} TO PUBLIC, ${svcRoles(from).join(', ')};`); sql(from, db, 'DROP PUBLICATION IF EXISTS mc_move;'); } catch { /* best effort */ }
        try { sql(from, 'postgres', `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = ${lit(sub)} AND NOT active;`); } catch { /* best effort */ }
        if (readOnlyAt) await tenantApi(`/internal/tenants/${t.id}/status`, { method: 'PATCH', body: { status: 'ACTIVE' } }).catch(() => undefined);
        // the half-made copy on the new server is ours (created above, never used): remove it so a retry can start clean
        try { if (created && /^t_[a-z0-9_]+$/.test(db)) sql(to, 'postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`); } catch { /* best effort */ }
      }
      await tenantApi(`/internal/moves/${moveId}`, { method: 'PATCH', body: { step: 'failed', status: 'FAILED', detail: { error: e.message.slice(0, 500), switched } } }).catch(() => undefined);
      fail(`${slug}: move failed${switched ? ' after the switch (the hospital runs on the new server)' : ' (rolled back: the hospital stays on ' + from.id + ')'}: ${e.message}`);
    }
  }

  return { run, sql, rows, servers, serverById, tenantBySlug, bootstrapServer, serverAdd, backupOne, drill, move };
}
