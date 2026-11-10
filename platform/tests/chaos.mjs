#!/usr/bin/env node
// Chaos tests (Phase 30 part 2): take one dependency away at a time, on the local stack, and check that MediCare
// degrades the way the runbooks say and recovers by itself when it returns (no service restarts):
//   Kafka down    → bookings still succeed (events wait in the outbox); when it is back the outbox drains and the
//                   patient's confirmation goes out.
//   Redis down    → reading keeps working, every instance stays ready, requests that need Redis fail fast with 503
//                   (never hang, never 500); when it is back, booking works again.
//   Payments down → an online booking is refused with PAYMENTS_UNAVAILABLE and its slot is given back at once; paying
//                   at the hospital still works; when it is back, online booking works.
//   Search down   → the patient site falls back to the directory.
// Only this project's own containers (compose project "medicare") are stopped, and always started again.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const C = 'citycare.localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
const waitFor = async (fn, ms = 30000, every = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every); } return undefined; };
const SFX = Date.now().toString().slice(-6);
// `CHAOS_ONLY=kafka,redis` runs some of the scenarios (kafka, redis, payments, search)
const only = (k) => !process.env.CHAOS_ONLY || process.env.CHAOS_ONLY.split(',').includes(k);
const compose = (...a) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), ...a], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const stopped = new Set();
const stop = (svc) => { stopped.add(svc); compose('stop', '-t', '5', svc); };
const start = (svc) => { compose('start', svc); stopped.delete(svc); };

async function call(method, path, token, body, opts = {}) {
  const t0 = Date.now();
  const r = await fetch(G + path, {
    method, signal: AbortSignal.timeout(opts.timeout ?? 30000),
    headers: { 'x-tenant-host': opts.host ?? C, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.idem !== false ? { 'idempotency-key': crypto.randomUUID() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => ({ status: 0, text: async () => e.message }));
  const raw = await r.text();
  let j = {};
  try { j = raw ? JSON.parse(raw) : {}; } catch { j = { text: raw }; }
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status, ms: Date.now() - t0 };
}
const internal = (port, method, path, body) => fetch(`http://localhost:${port}${path}`, { method, headers: { 'x-internal-token': env.INTERNAL_API_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ http: r.status, ...(await r.json().catch(() => ({}))) }));
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
/** The outbox backlog a service reports on its metrics port (service port + 5000). */
const outbox = async (port) => Number(/^mc_outbox_pending (\d+)/m.exec(await (await fetch(`http://localhost:${port + 5000}/metrics`)).text())?.[1] ?? NaN);
const SERVICES = { tenant: 4401, iam: 4402, entitlement: 4403, provider: 4404, scheduling: 4405, patient: 4406, notification: 4407, billing: 4409, records: 4410, diagnostics: 4412, search: 4414 };
const ready = async () => Object.fromEntries(await Promise.all(Object.entries(SERVICES).map(async ([k, p]) => [k, (await fetch(`http://localhost:${p}/health/ready`, { signal: AbortSignal.timeout(5000) }).catch(() => ({ status: 0 }))).status])));

async function patient() {
  const phone = `+9185${SFX}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const code = await waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6), 20000, 500);
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const me = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: `Chaos Test ${SFX}`, dob: '1988-03-03', gender: 'MALE' });
  return { token, id: me.id, phone };
}

// ---- setup: a patient and open times on different days (one booking per doctor per day)
const P = await patient();
const doctors = (await call('GET', '/api/provider/v1/public/doctors?limit=30')).items ?? [];
let slots = [];
for (const d of doctors) {
  const days = (await call('GET', `/api/scheduling/v1/public/doctors/${d.id}/slots?days=12`)).days ?? [];
  const per = days.slice(2).map((x) => x.slots.filter((s) => s.available !== false && !s.membersOnly && s.fee > 0).at(-1)).filter(Boolean);
  if (per.length >= 8) { slots = per; break; }
}
if (!P.token || slots.length < 8) throw new Error(`setup failed: patient ${!!P.token}, ${slots.length} open days`);
const book = (paymentMode = 'AT_CLINIC', opts = {}) => call('POST', '/api/scheduling/v1/appointments', P.token, { slotId: slots.shift().slotId, patientId: P.id, reason: 'chaos test', paymentMode }, opts);
const cancel = (id) => call('POST', `/api/scheduling/v1/appointments/${id}/cancel`, P.token, { reason: 'chaos test' });

try {
  const base = await book();
  check(base.http === 201, `baseline: a booking works (${base.http})`);
  await cancel(base.id);

  // ---- 1. Kafka
  if (only('kafka')) {
  stop('redpanda');
  const k1 = await book();
  check(k1.http === 201 && k1.ms < 5000, `Kafka down: booking still succeeds (${k1.http}, ${k1.ms} ms)`);
  check((await call('GET', '/api/scheduling/v1/me/appointments', P.token)).http === 200, 'Kafka down: the patient still sees their appointments');
  // the relay gives up on a send after KAFKA_SEND_TIMEOUT_MS (15 s) and then reports the backlog
const backlog = await waitFor(async () => { const n = await outbox(SERVICES.scheduling); if (process.env.CHAOS_DEBUG) console.log('outbox', n); return n > 0 ? n : null; }, 60000, 1000);
  check(backlog > 0, `Kafka down: the booking's events wait in the outbox (${backlog} pending)`);
  start('redpanda');
  const drained = await waitFor(async () => (await outbox(SERVICES.scheduling)) === 0, 180000, 2000);
  check(!!drained, 'Kafka back: the outbox drains by itself (no restart)');
  const sms = await waitFor(async () => (await mail(`to:${P.phone.slice(1)}@sms.medicare.local "${k1.appointmentNo}"`)).length > 0, 120000, 2000);
  check(!!sms, `Kafka back: the confirmation for ${k1.appointmentNo} reaches the patient`);
  await cancel(k1.id);
  }

  // ---- 2. Redis
  if (only('redis')) {
  stop('redis');
  await sleep(1500);
  const pubDocs = await call('GET', '/api/provider/v1/public/doctors?limit=5');
  check(pubDocs.http === 200, `Redis down: the public doctor list still answers (${pubDocs.http}, ${pubDocs.ms} ms)`);
  // past the services' in-memory permissions cache (ENTITLEMENTS_CACHE_MS, 30 s): entitlement-service must answer without Redis
  await sleep(31000);
  const mine = await call('GET', '/api/scheduling/v1/me/appointments', P.token);
  check(mine.http === 200 && mine.ms < 5000, `Redis down: a signed-in patient still reads their appointments (${mine.http}, ${mine.ms} ms)`);
  const r1 = await book();
  check(r1.http === 503 && r1.ms < 5000, `Redis down: a booking is refused fast and clearly (${r1.http} ${r1.code ?? ''}, ${r1.ms} ms), not a 500 or a hang`);
  const rdy = await ready();
  check(Object.values(rdy).every((s) => s === 200), `Redis down: every service stays ready, so reads keep being served (${Object.entries(rdy).filter(([, s]) => s !== 200).map(([k, s]) => `${k} ${s}`).join(', ') || 'all 200'})`);
  start('redis');
  const r2 = await waitFor(async () => { const b = await book('AT_CLINIC'); if (b.http === 201) return b; slots.unshift({ slotId: b.slotId ?? slots[0].slotId }); return null; }, 60000, 3000);
  check(!!r2, 'Redis back: booking works again by itself (no restart)');
  if (r2) await cancel(r2.id);
  }

  // ---- 3. the payment provider
  if (only('payments')) {
  await internal(SERVICES.billing, 'POST', '/internal/simulator/outage', { seconds: 300 });
  const slotId = slots[0].slotId;
  const p1 = await book('ONLINE');
  check(p1.http === 502 && p1.code === 'PAYMENTS_UNAVAILABLE', `payments down: an online booking is refused with ${p1.code} (${p1.http})`);
  check((await call('GET', `/api/scheduling/v1/public/slots/${slotId}`)).available === true, 'payments down: its slot is given back at once');
  const p2 = await book('AT_CLINIC');
  check(p2.http === 201, `payments down: paying at the hospital still works (${p2.http})`);
  await cancel(p2.id);
  await internal(SERVICES.billing, 'POST', '/internal/simulator/outage', { seconds: 0 });
  const p3 = await book('ONLINE');
  check(p3.http === 201 && !!p3.payment?.invoiceId, `payments back: online booking works again (${p3.http})`);
  if (p3.id) await cancel(p3.id);
  }

  // ---- 4. search
  if (only('search')) {
  stop('opensearch');
  const api = await call('GET', '/api/search/v1/public/search/doctors?q=chest+pain');
  const page = await fetch('http://citycare.localhost:3400/care/doctors?q=chest+pain', { signal: AbortSignal.timeout(60000) }).then((r) => r.text()).catch(() => '');
  check(api.http === 503 && api.code === 'SEARCH_UNAVAILABLE', `search down: the API says ${api.code} (${api.http}, ${api.ms} ms)`);
  check(/data-source="directory"/.test(page), `search down: the patient site falls back to the directory (${page ? (/data-source="(\w+)"/.exec(page)?.[1] ?? 'no results section') : 'page did not load'})`);
  start('opensearch');
  const back = await waitFor(async () => (await call('GET', '/api/search/v1/public/search/doctors?q=chest+pain')).http === 200, 180000, 3000);
  check(!!back, 'search back: answers again by itself');
  }
} finally {
  for (const s of [...stopped]) { try { start(s); } catch (e) { console.error(`could not start ${s}: ${e.message}`); } }
  await internal(SERVICES.billing, 'POST', '/internal/simulator/outage', { seconds: 0 }).catch(() => undefined);
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mchaos: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
