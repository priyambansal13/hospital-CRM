#!/usr/bin/env node
// Database servers, moves and release rings (Phase 30), against the local stack with the second Postgres server
// (postgres-b, registered here as pg-2, DEDICATED):
//   servers registered → a new hospital goes to the shared server, a dedicated one to pg-2 by name → data written
//   through the APIs → moved pg-1 → pg-2 while someone keeps editing (writes are refused only while read-only, none
//   acknowledged is lost) → everything still works on pg-2 (reads, bookings, the old copy closed) → moved back →
//   a failing move rolls back → migrations by ring (dedicated hospitals wait) → status.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mc = (...args) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** Async, so the editor below keeps running while the move does. */
const mcAsync = (...args) => promisify(execFile)('node', [join(PLATFORM, 'scripts/mc.mjs'), ...args], { encoding: 'utf8' }).then((r) => ({ ok: true, out: r.stdout + r.stderr }), (e) => ({ ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
const mcTry = (...args) => { try { return { ok: true, out: mc(...args) }; } catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; } };
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host) {
  const go = () => fetch(G + path, { method, headers: { ...(host ? { 'x-tenant-host': host } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  const r = await go().catch(() => go()); // a keep-alive socket the gateway closed while idle
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status, _body: j };
}
const internal = async (path, opts = {}) => (await fetch(`http://localhost:4401${path}`, { ...opts, headers: { 'x-internal-token': env.INTERNAL_API_TOKEN, 'content-type': 'application/json' } })).json();
async function staffToken(email, slug) {
  for (let i = 0; i < 40; i++) {
    const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
    if (j.access_token) return j.access_token;
    await sleep(500); // the admin account is created from the provisioning event
  }
  throw new Error(`login ${email} failed`);
}
const waitFor = async (fn, ms = 30000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
const psqlOn = (container, db, sql) => execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-qAt', '-d', db], { input: sql, encoding: 'utf8' }).trim();
/** A new hospital's modules switch on in the background: retry the first write until it is allowed. */
const firstWrite = (fn) => waitFor(async () => { const r = await fn(); return r.http === 201 || r.http === 200 ? r : undefined; }, 60000, 1000);
const tenant = async (slug) => (await internal('/internal/tenants')).find((t) => t.slug === slug);

const RUN = Date.now().toString().slice(-6);
const SLUG = `move${RUN}`;
const HOST = `${SLUG}.localhost`;
const DED = `vip${RUN}`;

// ---- 1. servers
mc('server', 'add', 'pg-2', '--pooled', 'localhost:61644', '--direct', 'localhost:61433', '--peer', 'postgres-b:5432', '--kind', 'DEDICATED', '--window', 'Sun 02:00-04:00 IST');
const servers = await internal('/internal/db-servers');
const pg1 = servers.find((s) => s.id === 'pg-1');
const pg2 = servers.find((s) => s.id === 'pg-2');
check(pg1?.kind === 'SHARED' && pg2?.kind === 'DEDICATED' && pg2.pooledPort === 61644, `servers: pg-1 shared (${pg1?.tenants} hospitals), pg-2 dedicated`);
check((await internal('/internal/tenants')).every((t) => t.dbServer === 'pg-1' || t.dbServer === 'pg-2') && (await internal('/internal/tenants')).find((t) => t.slug === 'citycare')?.dbServer === 'pg-1', 'every hospital has a server (the older ones on pg-1)');
check(psqlOn('medicare-postgres-b-1', 'postgres', `SELECT count(*) FROM pg_roles WHERE rolname IN ('svc_tenant','svc_scheduling','mc_replicator')`) === '3'
  && psqlOn('medicare-postgres-b-1', 'postgres', `SELECT datistemplate FROM pg_database WHERE datname = 'medicare_template'`) === 't', 'pg-2 bootstrapped: service roles, the replication role, its own template');

// ---- 2. placement of new hospitals
mc('tenant', 'create', SLUG, '--name', 'Move Test Hospital', '--admin', `admin@${SLUG}.test`, '--plan', 'HOSPITAL_PRO');
mc('tenant', 'create', DED, '--name', 'VIP Dedicated Hospital', '--admin', `admin@${DED}.test`, '--plan', 'HOSPITAL_PRO', '--server', 'pg-2');
check((await tenant(SLUG))?.dbServer === 'pg-1', 'a new hospital goes to the shared server (a dedicated server takes none unasked)');
const ded = await tenant(DED);
check(ded?.dbServer === 'pg-2' && ded.dbPort === 61644 && psqlOn('medicare-postgres-b-1', 'postgres', `SELECT count(*) FROM pg_database WHERE datname = '${ded.dbName}'`) === '1'
  && psqlOn('medicare-postgres-1', 'postgres', `SELECT count(*) FROM pg_database WHERE datname = '${ded.dbName}'`) === '0', `a dedicated hospital is created on pg-2 only (${ded?.dbName})`);
const dedAdmin = await staffToken(`admin@${DED}.test`, DED);
const dedBranch = await firstWrite(() => call('POST', '/api/tenant/v1/branches', dedAdmin, { name: 'VIP Tower', city: 'Mumbai', address: { line1: 'Marine Drive' } }, `${DED}.localhost`)) ?? {};
check(dedBranch.http === 201 && (await call('GET', '/api/tenant/v1/branches', dedAdmin, undefined, `${DED}.localhost`)).list?.some((b) => b.name === 'VIP Tower'), 'the dedicated hospital works through its own PgBouncer: branch written and read back');

// ---- 3. data in the hospital to move: branch, doctor, hours, a patient and a booking
const admin = await staffToken(`admin@${SLUG}.test`, SLUG);
const br = await firstWrite(() => call('POST', '/api/tenant/v1/branches', admin, { name: 'Main Wing', city: 'Pune', address: { line1: 'FC Road' } }, HOST)) ?? {};
await sleep(1500); // provider-service learns the branch from its event
const specs = (await call('GET', '/api/provider/v1/specialties', admin, undefined, HOST)).list ?? [];
const doc = await call('POST', '/api/provider/v1/doctors', admin, { name: 'Dr. Mohan Move', email: `mohan.${SLUG}@example.test`, registrationNo: `MMC/${SLUG}`, specialties: [{ code: specs[0]?.code, primary: true }], branches: [{ branchId: br.id, fee: 400 }], consultModes: ['IN_PERSON'] }, HOST);
await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'ACTIVE' }, HOST);
await waitFor(async () => (await call('POST', `/api/scheduling/v1/doctors/${doc.id}/availability`, admin, { days: [1, 2, 3, 4, 5, 6, 7], branchId: br.id, startTime: '06:00', endTime: '22:00', slotMinutes: 15 }, HOST)).http < 300, 20000);
const phone = `+9187${Date.now().toString().slice(-8)}`;
const since = Date.now() - 1000;
await call('POST', '/api/iam/v1/auth/otp/request', null, { phone }, HOST);
const smsFor = async () => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.slice(1)}@sms.medicare.local`)}`)).json()).messages ?? [];
const code = await waitFor(async () => (await smsFor()).find((x) => Date.parse(x.Created) >= since && /^\d{6} is your/.test(x.Snippet))?.Snippet.slice(0, 6), 20000);
const pt = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code }, HOST)).accessToken;
const me = await call('PUT', '/api/patient/v1/me/profile', pt, { fullName: 'Mira Mover', dob: '1985-05-05', gender: 'FEMALE' }, HOST);
const slots = await waitFor(async () => { const d = (await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=14`, null, undefined, HOST)).days; const all = (d ?? []).flatMap((x) => x.slots); return all.length > 3 ? all : undefined; }, 30000, 1000);
const appt = await call('POST', '/api/scheduling/v1/appointments', pt, { slotId: slots?.[0]?.slotId, patientId: me.id }, HOST);
check(br.http === 201 && doc.id && me.id && appt.http === 201, `data written across services: branch, doctor, hours, patient ${me.id?.slice(0, 8)}, appointment ${appt.id?.slice(0, 8)}`);
const t1 = await tenant(SLUG);
const before = psqlOn('medicare-postgres-1', t1.dbName, `SELECT (SELECT count(*) FROM scheduling.appointments) || '/' || (SELECT count(*) FROM patient.patients) || '/' || (SELECT count(*) FROM provider.doctors)`);

// ---- 4. move pg-1 → pg-2 while the admin keeps renaming the branch
let editing = true;
let ver = br.version;
const acked = [];
const tried = [];
const refused = { readOnly: 0, other: 0, codes: [] };
const editor = (async () => {
  for (let i = 1; editing; i++) {
    tried.push(i);
    const r = await call('PATCH', `/api/tenant/v1/branches/${br.id}`, admin, { name: `Main Wing ${i}`, version: ver }, HOST).catch(() => ({ http: 0 }));
    if (r.http === 200) { acked.push(i); ver = r.version; }
    else if (r.code === 'TENANT_READ_ONLY') refused.readOnly++;
    else { refused.other++; refused.codes.push(r.code ?? r.http); }
    await sleep(150);
  }
})();
await sleep(1500);
const moved = await mcAsync('tenant', 'move', SLUG, 'pg-2');
await sleep(2500);
editing = false;
await editor;
const t2 = await tenant(SLUG);
const readOnlySecs = /read-only for ([\d.]+)s/.exec(moved.out)?.[1];
check(moved.ok && t2.dbServer === 'pg-2' && t2.dbPort === 61644 && t2.status === 'ACTIVE', `moved to pg-2 (read-only for ${readOnlySecs}s): ${moved.ok ? 'catalog points at pg-2, hospital ACTIVE' : moved.out.split('\n').slice(-3).join(' ')}`);
const moves = await internal(`/internal/tenants/${t2.id}/moves`);
check(moves[0]?.status === 'DONE' && moves[0].step === 'done' && moves[0].read_only_ms > 0 && /^pg-1\/moved_/.test(moves[0].detail?.retiredCopy ?? ''), `move recorded step by step (read-only ${moves[0]?.read_only_ms} ms, old copy ${moves[0]?.detail?.retiredCopy})`);
check(refused.readOnly > 0 && refused.other === 0, `while read-only, edits were refused with TENANT_READ_ONLY (${refused.readOnly}), nothing else failed (${refused.other}${refused.codes.length ? `: ${refused.codes.join(' ')}` : ''}); ${acked.length} edits accepted`);
const after = psqlOn('medicare-postgres-b-1', t2.dbName, `SELECT (SELECT count(*) FROM scheduling.appointments) || '/' || (SELECT count(*) FROM patient.patients) || '/' || (SELECT count(*) FROM provider.doctors)`);
check(after === before, `the copy on pg-2 has the same appointments/patients/doctors (${after})`);
const name = await waitFor(async () => (await call('GET', `/api/tenant/v1/branches/${br.id}`, admin, undefined, HOST)).name, 10000);
const n = Number(/Main Wing (\d+)$/.exec(name ?? '')?.[1]);
check(n >= acked.at(-1) && tried.includes(n), `no accepted edit was lost: the branch reads "${name}" (last accepted ${acked.at(-1)})`);
check(psqlOn('medicare-postgres-1', 'postgres', `SELECT count(*) FROM pg_database WHERE datname = '${t2.dbName}'`) === '0'
  && psqlOn('medicare-postgres-1', 'postgres', `SELECT count(*) FROM pg_database WHERE datname LIKE 'moved\\_${t2.dbName}\\_%' AND NOT datallowconn`) === '1', 'the old copy on pg-1 is renamed and closed to connections (kept for a rollback window)');
check(psqlOn('medicare-postgres-1', 'postgres', `SELECT count(*) FROM pg_replication_slots WHERE slot_name LIKE 'mc_move_%'`) === '0'
  && psqlOn('medicare-postgres-b-1', 'postgres', `SELECT count(*) FROM pg_subscription`) === '0', 'no replication slot or subscription left behind');
const seqOk = psqlOn('medicare-postgres-b-1', t2.dbName, `SELECT bool_and(coalesce(last_value, 0) >= 0) FROM pg_sequences`) === 't';
const appt2 = await call('POST', '/api/scheduling/v1/appointments', pt, { slotId: slots?.[2]?.slotId, patientId: me.id }, HOST);
const mine = (await call('GET', '/api/scheduling/v1/me/appointments', pt, undefined, HOST)).upcoming ?? [];
check(seqOk && appt2.http === 201 && mine.length >= 2, `after the move: the patient books again (${appt2.http}) and sees ${mine.length} appointments; sequences carried over`);
check(psqlOn('medicare-postgres-b-1', t2.dbName, `SELECT count(*) FROM scheduling.appointments`) === String(Number(before.split('/')[0]) + 1), 'the new booking is written on pg-2');

// ---- 5. back to pg-1 (the earlier copy there is retired, so the name is free again)
const back = mcTry('tenant', 'move', SLUG, 'pg-1');
const t3 = await tenant(SLUG);
const nameBack = (await call('GET', `/api/tenant/v1/branches/${br.id}`, admin, undefined, HOST)).name;
const apptsBack = psqlOn('medicare-postgres-1', t3.dbName, 'SELECT count(*) FROM scheduling.appointments');
check(back.ok && t3.dbServer === 'pg-1' && nameBack === name && apptsBack === String(Number(before.split('/')[0]) + 1),
  `moved back to pg-1 with everything, including the booking made on pg-2 (${/read-only for ([\d.]+)s/.exec(back.out)?.[1]}s read-only; ${t3.dbServer}, "${nameBack}", ${apptsBack} appointments)${back.ok ? '' : ` ${back.out.split('\n').slice(-2).join(' ')}`}`);

// ---- 6. a move that cannot finish rolls back
check(!mcTry('tenant', 'move', SLUG, 'pg-1').ok && !mcTry('tenant', 'move', SLUG, 'pg-9').ok, 'moving to the same server or an unknown one is refused');
psqlOn('medicare-postgres-b-1', 'postgres', `CREATE DATABASE ${t3.dbName}`); // something already in the way on pg-2
const blocked = mcTry('tenant', 'move', SLUG, 'pg-2');
const t4 = await tenant(SLUG);
check(!blocked.ok && /rolled back/.test(blocked.out) && t4.dbServer === 'pg-1' && t4.status === 'ACTIVE'
  && (await call('PATCH', `/api/tenant/v1/branches/${br.id}`, admin, { name: 'Main Wing after rollback', version: (await call('GET', `/api/tenant/v1/branches/${br.id}`, admin, undefined, HOST)).version }, HOST)).http === 200, 'a move that fails rolls back: still on pg-1, ACTIVE, writable');
check(psqlOn('medicare-postgres-b-1', 'postgres', `SELECT count(*) FROM pg_database WHERE datname = '${t3.dbName}'`) === '1', 'a database that was already on the target is left alone');
psqlOn('medicare-postgres-b-1', 'postgres', `DROP DATABASE ${t3.dbName}`); // the one this test created above
check((await internal(`/internal/tenants/${t4.id}/moves`))[0]?.status === 'FAILED', 'the failed move is recorded');

// ---- 7. release rings
const plan = await internal('/internal/migration-plan');
check(plan.tenants.find((t) => t.slug === DED)?.ring === 3 && plan.tenants.find((t) => t.slug === SLUG)?.ring === 2 && plan.servers.some((s) => s.id === 'pg-2'), 'migration plan: the dedicated hospital is in ring 3, others in ring 2');
mc('tenant', 'ring', SLUG, '1');
check((await tenant(SLUG))?.ring === 1, 'a hospital can be made a pilot (ring 1)');
const partial = mc('migrate', '--max-ring', '2');
check(/ring 1 on pg-1: \d+ hospital/.test(partial) && /in rings above 2 not migrated yet/.test(partial) && /template on pg-2/.test(partial), 'mc migrate --max-ring 2: templates on both servers, pilots before everyone, dedicated hospitals held back');
const full = mc('migrate');
check(/ring 3 on pg-2: \d+ hospital/.test(full), 'mc migrate (maintenance window): the dedicated server too');
check(/all \d+ hospital\(s\) at the latest version/.test(mc('migrate', 'status')), 'mc migrate status: every hospital at the latest version');
mc('tenant', 'ring', SLUG, '2');

// ---- 8. isolation still holds after the moves
const cross = (await call('GET', `/api/tenant/v1/branches/${br.id}`, dedAdmin, undefined, `${DED}.localhost`)).http;
const wrongHost = (await call('GET', '/api/tenant/v1/branches', admin, undefined, `${DED}.localhost`)).http;
check(cross === 404 && [401, 403].includes(wrongHost), `hospitals stay apart across servers: another hospital's branch id → ${cross}, a token on the wrong hospital → ${wrongHost}`);

// the two test hospitals are test data: mark them DELETED (data kept, never purged) so they don't add to every
// service's background work on later runs
for (const s of [SLUG, DED]) {
  const t = (await internal('/internal/tenants')).find((x) => x.slug === s);
  if (t) await fetch(`http://localhost:4401/internal/tenants/${t.id}/status`, { method: 'PATCH', headers: { 'x-internal-token': env.INTERNAL_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'DELETED' }) });
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mall checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
