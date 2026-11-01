#!/usr/bin/env node
// Per-hospital backups and restore drills (Phase 30), against the local stack:
//   a backup of a busy hospital (someone keeps writing) → encrypted at rest, recorded with its counts and versions →
//   restore drill into a scratch database matches exactly (one snapshot) → a damaged file is caught → each hospital
//   has its own key (one hospital's key cannot open another's backup) → nightly run over every hospital → status.
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mc = (...args) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const mcTry = (...args) => { try { return { ok: true, out: mc(...args) }; } catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; } };
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
const internal = async (path, opts = {}) => (await fetch(`http://localhost:4401${path}`, { ...opts, headers: { 'x-internal-token': env.INTERNAL_API_TOKEN, 'content-type': 'application/json' } })).json();
async function call(method, path, token, body, host) {
  const go = () => fetch(G + path, { method, headers: { ...(host ? { 'x-tenant-host': host } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  const r = await go().catch(() => go()); // a keep-alive socket the gateway closed while idle
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
async function staffToken(email, slug) {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const tenants = await internal('/internal/tenants');
const city = tenants.find((t) => t.slug === 'citycare');
const sunrise = tenants.find((t) => t.slug === 'sunrise');
const HOST = 'citycare.localhost';

// ---- 1. a backup while the hospital is busy
const admin = await staffToken('admin@citycare.test', 'citycare');
const branch = (await call('GET', '/api/tenant/v1/branches', admin, undefined, HOST)).list?.[0];
let busy = true;
let writes = 0;
const writer = (async () => {
  let ver = branch?.version;
  const original = branch?.name;
  for (let i = 0; busy && branch; i++) {
    const r = await call('PATCH', `/api/tenant/v1/branches/${branch.id}`, admin, { name: i % 2 ? `${original} ` : original, version: ver }, HOST);
    if (r.http === 200) { ver = r.version; writes++; }
    await sleep(50);
  }
  if (branch) await call('PATCH', `/api/tenant/v1/branches/${branch.id}`, admin, { name: original, version: ver }, HOST);
})();
await sleep(300);
const out = mc('backup', 'run', 'citycare');
busy = false;
await writer;
const list = await internal(`/internal/tenants/${city.id}/backups`);
const b = list[0];
check(/citycare: backup [0-9a-f]{8} \(MANUAL\)/.test(out) && b?.kind === 'MANUAL' && Number(b.bytes) > 10_000 && Object.keys(b.tables).length > 50, `backup recorded: ${(Number(b?.bytes) / 1e6).toFixed(2)} MB, ${Object.keys(b?.tables ?? {}).length} tables, taken while ${writes} edits went in`);
check(Object.keys(b.versions).includes('scheduling') && Object.keys(b.versions).includes('tenant') && b.server_id === city.dbServer, `schema versions recorded with it (${Object.keys(b.versions).length} services), from ${b.server_id}`);
const file = readFileSync(b.location);
check(file.subarray(0, 5).toString() === 'MCBK1' && !file.includes(Buffer.from('PGDMP')) && !file.includes(Buffer.from('CityCare')), 'the file is encrypted: no pg_dump header, no hospital name in it');

// ---- 2. restore drill
const drill = mcTry('backup', 'drill', 'citycare');
const after = (await internal(`/internal/tenants/${city.id}/backups`))[0];
check(drill.ok && after.drill_ok === true && Number(after.drill_seconds) > 0 && after.drill_report?.problems?.length === 0, `restore drill passed in ${after.drill_seconds}s: every table's row count and every schema version match (${after.drill_report?.rows} rows)`);
check(execFileSync('docker', ['exec', 'medicare-postgres-1', 'psql', '-U', 'postgres', '-qAt', '-c', "SELECT count(*) FROM pg_database WHERE datname LIKE 'drill\\_%'"], { encoding: 'utf8' }).trim() === '0', 'the scratch database is removed afterwards');

// ---- 3. a damaged backup is caught
mc('backup', 'run', 'citycare');
const damaged = (await internal(`/internal/tenants/${city.id}/backups`))[0];
const bytes = readFileSync(damaged.location);
bytes[Math.floor(bytes.length / 2)] ^= 0xff;
writeFileSync(damaged.location, bytes);
const bad = mcTry('backup', 'drill', 'citycare', '--id', damaged.id.slice(0, 8));
const badRow = (await internal(`/internal/tenants/${city.id}/backups`)).find((x) => x.id === damaged.id);
check(!bad.ok && badRow.drill_ok === false && /checksum/.test(JSON.stringify(badRow.drill_report)), `a damaged file fails its drill (${badRow.drill_report?.problems?.[0]})`);

// ---- 4. each hospital has its own key
mc('backup', 'run', 'sunrise');
const sb = (await internal(`/internal/tenants/${sunrise.id}/backups`))[0];
// sunrise's file put where citycare's last good backup is recorded: right checksum is not enough, citycare's key fails
const good = (await internal(`/internal/tenants/${city.id}/backups`)).find((x) => x.drill_ok === true);
const saved = readFileSync(good.location);
copyFileSync(sb.location, good.location);
const swapped = execFileSync('node', ['-e', `
  const { createDecipheriv } = require('node:crypto'); const fs = require('node:fs');
  const body = fs.readFileSync(${JSON.stringify(good.location)});
  try { const d = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 1), body.subarray(5, 17)); d.setAAD(Buffer.from(${JSON.stringify(`${city.id}:${good.id}`)})); d.setAuthTag(body.subarray(body.length - 16)); d.update(body.subarray(17, body.length - 16)); d.final(); console.log('opened'); } catch { console.log('refused'); }`], { encoding: 'utf8' }).trim();
writeFileSync(good.location, saved);
const keyA = await internal(`/internal/tenants/${city.id}/backup-key`);
const keyB = await internal(`/internal/tenants/${sunrise.id}/backup-key`);
check(swapped === 'refused' && keyA.wrapped && keyB.wrapped && keyA.wrapped !== keyB.wrapped && !keyA.wrapped.includes(env.BACKUP_MASTER_KEY), 'each hospital has its own backup key, stored wrapped by the master key; a backup does not open with a wrong key');
const resumed = mcTry('backup', 'drill', 'citycare', '--id', good.id.slice(0, 8));
check(resumed.ok, 'the original backup still restores after the file is put back');

// ---- 5. nightly run and status
const nightly = mcTry('backup', 'run', '--all');
const n = (nightly.out.match(/backup [0-9a-f]{8} \(NIGHTLY\)/g) ?? []).length;
check(nightly.ok && n === tenants.filter((t) => t.status === 'ACTIVE' || t.status === 'READ_ONLY').length, `nightly run: ${n} hospitals backed up, each on its own server`);
const status = mc('backup', 'status');
check(/citycare/.test(status) && !/without a backup in the last 26 hours/.test(status), 'backup status: every hospital backed up in the last day');
const summary = await internal('/internal/backups/summary');
check(summary.every((r) => r.backup_id) && summary.find((r) => r.slug === 'citycare')?.drill_ok === true, 'summary for the console and alerts: latest backup and drill per hospital');

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mall checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
