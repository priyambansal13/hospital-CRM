#!/usr/bin/env node
// Analytics warehouse and semantic layer (Phase 29, part 1), against the local gateway, on citycare:
//   module on → backfill from the owning services matches their own tables; the warehouse is de-identified;
//   new events arrive (registration, walk-in, no-show, counter payment); a branch admin only sees their branch and not
//   hospital-wide facts; bad queries are refused; CSV export; module reset.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': 'citycare.localhost', 'idempotency-key': crypto.randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if ((r.headers.get('content-type') ?? '').startsWith('text/csv')) return { http: r.status, csv: await r.text(), type: r.headers.get('content-type') };
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
async function staffToken(email) {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:citycare' }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
const waitFor = async (fn, ms = 20000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
async function patient(name) {
  const phone = `+9187${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const code = await waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6), 10000, 300);
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: name, dob: '1990-05-05', gender: 'MALE' });
  return { token, phone, self };
}
const mc = (...a) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const psql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
const SFX = Date.now().toString().slice(-6);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const from = new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);
const metric = (token, m, o = {}) => call('POST', '/api/analytics/v1/analytics/query', token, { metric: m, from: o.from ?? from, to: o.to ?? today, groupBy: o.groupBy, filters: o.filters ?? {}, limit: 50 });

try {
  // ---- 1. module on → backfill
  const admin = await staffToken('admin@citycare.test');
  const desk = await staffToken('desk@citycare.test');
  // off (or read-only after an earlier run switched it off: reads stay open, nothing new)
  check((await call('POST', '/api/analytics/v1/analytics/query', admin, { metric: 'appointments', from, to: today })).http === 403, 'module off: analytics queries are refused');
  mc('module', 'enable', 'citycare', 'analytics');
  const loaded = await waitFor(async () => { const s = await call('GET', '/api/analytics/v1/analytics/status', admin); return s.http === 200 && s.loads?.length === 4 && s.loads.every((l) => l.status === 'DONE') ? s : null; }, 120000, 2000);
  check(!!loaded, `module on: warehouse loaded (${loaded?.loads.map((l) => `${l.source} ${l.rows}`).join(', ')})`);
  const cat = await call('GET', '/api/analytics/v1/analytics/catalog', admin);
  check(cat.metrics?.length >= 15 && cat.metrics.some((m) => m.key === 'no_show_rate' && m.dimensions.includes('weekday')), `semantic layer: ${cat.metrics?.length} metrics, ${cat.dimensions?.length} dimensions`);
  check((await call('GET', '/api/analytics/v1/analytics/catalog', desk)).http === 403, 'the front desk cannot read analytics');

  // the warehouse agrees with the services' own tables (nothing else is booking on citycare during the suite)
  const appts = Number(psql(`SELECT count(*) FROM scheduling.appointments WHERE local_date BETWEEN '${from}' AND '${today}' AND status NOT IN ('RESCHEDULED','EXPIRED','PENDING_PAYMENT')`));
  const noShows = Number(psql(`SELECT count(*) FROM scheduling.appointments WHERE local_date BETWEEN '${from}' AND '${today}' AND status = 'NO_SHOW'`));
  const wa = await metric(admin, 'appointments');
  const wn = await metric(admin, 'no_shows');
  check(wa.value === appts && wn.value === noShows, `appointments (${wa.value}) and no-shows (${wn.value}) match scheduling's tables (${appts}, ${noShows})`);
  const paid = Number(psql(`SELECT coalesce(sum(p.amount), 0) FROM billing.payments p WHERE p.status = 'CAPTURED' AND NOT EXISTS (SELECT 1 FROM billing.refunds r WHERE r.payment_id = p.id AND r.dedupe_key LIKE 'duplicate:%')`));
  const back = Number(psql(`SELECT coalesce(sum(amount), 0) FROM billing.refunds WHERE status = 'PROCESSED' AND coalesce(dedupe_key, '') NOT LIKE 'duplicate:%'`));
  const rev = await metric(admin, 'revenue', { from: '2025-11-01' });
  check(Math.abs(rev.value - (paid - back)) < 1, `net revenue since the start (₹${rev.value}) matches billing (₹${paid} paid − ₹${back} refunded)`);
  const labs = Number(psql(`SELECT count(*) FROM diagnostics.lab_orders WHERE status NOT IN ('CANCELLED','EXPIRED') AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '${from}' AND '${today}'`));
  check((await metric(admin, 'lab_orders')).value === labs, `lab orders match diagnostics (${labs})`);

  // ---- 2. de-identified
  const cols = psql(`SELECT string_agg(table_name || '.' || column_name, ',') FROM information_schema.columns WHERE table_schema = 'analytics'`).split(',');
  check(!cols.some((c) => /patient_(id|name|mrn)|\.mrn$|phone|email|\.dob$|address/.test(c)), 'no patient names, MRNs, contact details or dates of birth in the warehouse');
  const somePatient = psql(`SELECT id FROM patient.patients LIMIT 1`);
  check(psql(`SELECT count(*) FROM analytics.fact_appointments WHERE patient_key = '${somePatient}' OR patient_key LIKE '${somePatient.slice(0, 8)}%'`) === '0', 'patients are a keyed hash, not their id');

  // ---- 3. live events
  const me = await call('GET', '/api/scheduling/v1/me/doctor', await staffToken('asha.rao@citycare.test'));
  const branches = (await call('GET', '/api/diagnostics/v1/public/lab-branches')).list;
  const A = branches.find((b) => b.name === 'Sector 44') ?? branches[0];
  const base = { from: today, to: today, filters: { doctorId: me.id } };
  const np0 = (await metric(admin, 'new_patients', { from: today })).value;
  const a0 = (await metric(admin, 'appointments', base)).value;
  const ns0 = (await metric(admin, 'no_shows', base)).value;
  const r0 = (await metric(admin, 'revenue', { from: today, to: today, filters: { branchId: A.id } })).value;
  const P = await patient(`Analytics Patient ${SFX}`);
  check(!!(await waitFor(async () => (await metric(admin, 'new_patients', { from: today })).value === np0 + 1, 20000, 1000)), `a registration counts as a new patient today (${np0} → ${np0 + 1})`);
  const walk = await waitFor(async () => { const r = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: P.self.id, walkIn: { doctorId: me.id, branchId: A.id } }); return r.http === 201 ? r : null; }, 15000, 1000);
  check(!!(await waitFor(async () => (await metric(admin, 'appointments', base)).value === a0 + 1, 20000, 1000)), `a walk-in arrives as an appointment for Dr. Asha today (${a0} → ${a0 + 1})`);
  const inv = await waitFor(async () => { const r = await call('POST', '/api/billing/v1/desk/collect', desk, { sourceType: 'APPOINTMENT', sourceId: walk.id, method: 'CASH' }); return r.http === 201 ? r : null; }, 15000, 1000);
  const fee = inv?.total ?? inv?.invoice?.total ?? 0;
  check(!!inv && !!(await waitFor(async () => (await metric(admin, 'revenue', { from: today, to: today, filters: { branchId: A.id } })).value === r0 + fee, 20000, 1000)), `cash at the counter (₹${fee}) shows in ${A.name}'s revenue today`);
  await call('POST', `/api/scheduling/v1/appointments/${walk.id}/no-show`, desk);
  check(!!(await waitFor(async () => (await metric(admin, 'no_shows', base)).value === ns0 + 1, 20000, 1000)), 'marking the no-show moves the no-show count');
  const wk = await metric(admin, 'no_show_rate', { groupBy: 'weekday' });
  check(wk.rows?.length === 7 && wk.rows[0].label === 'Mon' && wk.unit === 'percent', `no-show rate by weekday: ${wk.rows?.map((r) => `${r.label} ${r.value ?? '—'}%`).join(', ')}`);
  const sp = await metric(admin, 'appointments', { groupBy: 'specialty' });
  check(sp.rows?.length > 0 && sp.rows.every((r) => r.label && !/^[A-Z_]+$/.test(r.label) || r.label === 'ENT'), `by department: ${sp.rows?.slice(0, 3).map((r) => `${r.label} ${r.value}`).join(', ')}`);
  const sum = await call('GET', `/api/analytics/v1/analytics/summary?from=${from}&to=${today}`, admin);
  check(sum.kpis?.some((k) => k.metric === 'appointments' && k.value === (wa.value + 1)) && sum.kpis.some((k) => k.metric === 'new_patients'), `summary tiles with the period before (${sum.kpis?.length} tiles)`);

  // ---- 4. a branch admin sees their branch only
  const B = branches.find((b) => b.id !== A.id);
  const email = `anbr.${SFX}@example.test`;
  const invite = await call('POST', '/api/iam/v1/staff/invites', admin, { email, name: `Branch Analyst ${SFX}`, roles: ['BRANCH_ADMIN'], branchId: B.id });
  await waitFor(async () => (await call('GET', `/api/entitlement/v1/users/${invite.userId}/roles`, admin)).list?.length > 0);
  const ba = await waitFor(() => staffToken(email).catch(() => null), 20000, 1000);
  const byBranch = await metric(ba, 'appointments', { groupBy: 'branch' });
  check(byBranch.http === 200 && byBranch.rows.every((r) => r.key === B.id), `branch admin at ${B.name}: only their branch (${byBranch.rows?.map((r) => r.label).join(', ') || 'none'})`);
  check((await metric(ba, 'revenue', { from: today, to: today, filters: { branchId: A.id } })).value === 0, `asking for ${A.name} gives nothing (scope always applies)`);
  const wide = await metric(ba, 'new_patients');
  check(wide.http === 403 && wide.code === 'HOSPITAL_WIDE_ONLY', 'hospital-wide numbers (new patients) are refused to a branch admin');
  check(!(await call('GET', `/api/analytics/v1/analytics/summary?from=${from}&to=${today}`, ba)).kpis?.some((k) => k.metric === 'new_patients'), 'their summary leaves the hospital-wide tile out');

  // ---- 5. validation, CSV
  check((await call('POST', '/api/analytics/v1/analytics/query', admin, { metric: 'drop_table', from, to: today })).http === 400, 'an unknown metric is refused');
  check((await metric(admin, 'revenue', { groupBy: 'doctor' })).code === 'DIMENSION_NOT_AVAILABLE', 'a split the metric does not have is refused');
  check((await metric(admin, 'revenue', { from: '2024-01-01' })).http === 400, 'more than 400 days at a time is refused');
  const csv = await call('GET', `/api/analytics/v1/analytics/export.csv?metric=no_show_rate&from=${from}&to=${today}&groupBy=weekday`, admin);
  check(csv.http === 200 && csv.type?.startsWith('text/csv') && csv.csv.startsWith('"Day of the week","No-show rate (percent)"') && csv.csv.includes('"Mon"'), 'CSV export of a split');
} catch (e) {
  console.error(e);
  failures++;
} finally {
  try { mc('module', 'reset', 'citycare', 'analytics'); } catch { /* reported above */ }
}
console.log(failures ? `\x1b[31m${failures} check(s) failed\x1b[0m` : '\x1b[32mall analytics checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
