// k6: the morning booking rush (docs/LLD.md §17, targets from docs/HLD.md §3). Run with `mc load run`.
//   search: patients search doctors (a symptom, a specialty or a name), then open one doctor's free times;
//   book:   a signed-in patient books a free time (pay at the hospital), then cancels it, so the hospital's
//           times are never used up and a patient never reaches the limit of active bookings.
// Profiles (PROFILE): "smoke" to check the script (10 + 1 per second, 1 minute); "local" for a laptop (40 searches/s + 4 bookings/s for 3 minutes); "rush" is the platform
// target (200 searches/s + 20 bookings/s for 30 minutes after a 2-minute ramp), for staging.
// Every simulated patient comes from its own address (X-Forwarded-For), as real phones do; the gateway's per-address
// rate limit then applies per patient, not to the whole test.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const DATA = JSON.parse(open(__ENV.DATA ?? '/load/.data/loadtest.json'));
const BASE = __ENV.BASE ?? 'http://host.docker.internal:61000';
const HOST = __ENV.TENANT_HOST ?? DATA.host;
const PROFILE = __ENV.PROFILE ?? 'local';

const P = {
  smoke: { search: 10, book: 1, ramp: '15s', hold: '1m' },
  local: { search: 40, book: 4, ramp: '30s', hold: '3m' },
  rush: { search: 200, book: 20, ramp: '2m', hold: '30m' },
}[PROFILE];

const refused = new Counter('bookings_refused');  // the business said no (time just taken, one a day per doctor…)
const booked = new Counter('bookings_made');
const bookTime = new Trend('booking_duration', true);

export const options = {
  scenarios: {
    search: {
      executor: 'ramping-arrival-rate', exec: 'search', startRate: 1, timeUnit: '1s', preAllocatedVUs: Math.ceil(P.search / 2), maxVUs: P.search * 3,
      stages: [{ target: P.search, duration: P.ramp }, { target: P.search, duration: P.hold }],
    },
    book: {
      executor: 'ramping-arrival-rate', exec: 'book', startRate: 1, timeUnit: '1s', preAllocatedVUs: P.book * 2, maxVUs: Math.min(P.book * 8, DATA.patients.length),
      stages: [{ target: P.book, duration: P.ramp }, { target: P.book, duration: P.hold }],
    },
  },
  thresholds: {
    // docs/HLD.md §3: doctor search p95 < 300 ms, booking p95 < 500 ms; the free-times list has no stated target
    'http_req_duration{name:search}': ['p(95)<300'],
    'http_req_duration{name:book}': ['p(95)<500'],
    'http_req_duration{name:slots}': ['p(95)<500'],
    'http_req_failed': ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

let logged = 0;
/** The first few unexpected answers per VU, so a failed run says why (status and the problem code). */
function note(name, r) {
  if (logged++ < 3) console.warn(`${name}: ${r.status} ${r.error || ''} ${String(r.body ?? '').slice(0, 140)}`);
}
const headers = (ip, token) => ({ 'x-tenant-host': HOST, 'x-forwarded-for': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) });
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** Fresh access tokens for every patient (refresh tokens rotate: each VU keeps its own from here on). */
export function setup() {
  const sessions = [];
  for (const p of DATA.patients) {
    const r = http.post(`${BASE}/api/iam/v1/auth/refresh`, JSON.stringify({ refreshToken: p.refreshToken }), { headers: { ...headers(p.ip), 'content-type': 'application/json' }, tags: { name: 'setup' } });
    // POST answers 201
    if (r.status >= 200 && r.status < 300) sessions.push({ ...p, accessToken: r.json('accessToken'), refreshToken: r.json('refreshToken'), at: Date.now() });
  }
  if (!sessions.length) throw new Error('no patient could sign in: run `mc load prepare` again');
  return { sessions };
}

export function search() {
  const ip = `10.66.${exec.vu.idInTest % 250}.${(exec.scenario.iterationInTest % 250) + 1}`;
  const r = http.get(`${BASE}/api/search/v1/public/search/doctors?q=${encodeURIComponent(pick(DATA.words))}&limit=10`, { headers: headers(ip), tags: { name: 'search' } });
  if (!check(r, { 'search 200': (x) => x.status === 200 })) note('search', r);
  // four in ten go on to a doctor's free times
  if (Math.random() < 0.4) {
    const s = http.get(`${BASE}/api/scheduling/v1/public/doctors/${pick(DATA.doctors)}/slots?days=7`, { headers: headers(ip), tags: { name: 'slots' } });
    if (!check(s, { 'slots 200': (x) => x.status === 200 })) note('slots', s);
  }
}

const mine = {};
/** This VU's patient (one patient per VU, so two VUs never book as the same person at once). */
function session(data) {
  const id = exec.vu.idInTest;
  if (!mine[id]) mine[id] = { ...data.sessions[id % data.sessions.length] };
  const s = mine[id];
  // access tokens last 15 minutes: refresh after 12
  if (Date.now() - s.at > 12 * 60_000) {
    const r = http.post(`${BASE}/api/iam/v1/auth/refresh`, JSON.stringify({ refreshToken: s.refreshToken }), { headers: { ...headers(s.ip), 'content-type': 'application/json' }, tags: { name: 'refresh' } });
    if (r.status >= 200 && r.status < 300) Object.assign(s, { accessToken: r.json('accessToken'), refreshToken: r.json('refreshToken'), at: Date.now() });
  }
  return s;
}

export function book(data) {
  const s = session(data);
  const doctor = pick(DATA.doctors);
  const list = http.get(`${BASE}/api/scheduling/v1/public/doctors/${doctor}/slots?days=14`, { headers: headers(s.ip), tags: { name: 'slots' } });
  if (!check(list, { 'slots 200': (x) => x.status === 200 })) { note('slots', list); return; }
  const days = (list.json('days') ?? []).slice(1);
  const open = days.flatMap((d) => d.slots).filter((x) => x.available !== false && !x.membersOnly);
  if (!open.length) return;
  const slot = pick(open);
  const res = http.post(`${BASE}/api/scheduling/v1/appointments`, JSON.stringify({ slotId: slot.slotId, patientId: s.id, reason: 'load test', paymentMode: 'AT_CLINIC' }), {
    headers: { ...headers(s.ip, s.accessToken), 'content-type': 'application/json', 'idempotency-key': `${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${Date.now()}` },
    tags: { name: 'book' }, responseCallback: http.expectedStatuses(201, 409, 422),
  });
  bookTime.add(res.timings.duration);
  if (!check(res, { 'booking answered (made or refused by a rule)': (x) => [201, 409, 422].includes(x.status) })) note('book', res);
  if (res.status !== 201) { refused.add(1); return; }
  booked.add(1);
  const c = http.post(`${BASE}/api/scheduling/v1/appointments/${res.json('id')}/cancel`, JSON.stringify({ reason: 'load test' }), {
    headers: { ...headers(s.ip, s.accessToken), 'content-type': 'application/json', 'idempotency-key': `c-${res.json('id')}` }, tags: { name: 'cancel' },
  });
  check(c, { 'cancel 2xx': (x) => x.status >= 200 && x.status < 300 });
  sleep(0.1);
}

/**
 * The run's result: a short table on screen, the full summary in results/, and the patients' rotated refresh tokens
 * written back so the next run (or `mc load prepare`) doesn't have to sign everyone in again.
 */
export function handleSummary(data) {
  const m = data.metrics;
  const row = (label, key) => {
    const v = m[key]?.values;
    return v ? `${label.padEnd(16)} p50 ${v.med.toFixed(0).padStart(5)} ms   p95 ${v['p(95)'].toFixed(0).padStart(5)} ms   p99 ${v['p(99)'].toFixed(0).padStart(5)} ms   max ${v.max.toFixed(0).padStart(6)} ms` : `${label.padEnd(16)} (none)`;
  };
  // a threshold on a metric with no samples "passes" in k6: report it as NO DATA instead
  const passed = Object.entries(m).filter(([, x]) => x.thresholds).map(([k, x]) => `${(x.type === 'trend' && !(x.values.max > 0)) || (x.type === 'rate' && x.values.passes + x.values.fails === 0) ? 'NO DATA' : Object.values(x.thresholds).every((t) => t.ok) ? 'PASS' : 'FAIL'}  ${k}  ${Object.keys(x.thresholds).join(', ')}`);
  const rate = (k) => (m[k] ? `${m[k].values.count} (${m[k].values.rate.toFixed(1)}/s)` : '0');
  const text = [
    `\nMorning rush, profile "${PROFILE}" against ${BASE} (${HOST})`,
    `requests ${rate('http_reqs')}, failed ${((m.http_req_failed?.values.rate ?? 0) * 100).toFixed(2)}%, checks ${((m.checks?.values.rate ?? 0) * 100).toFixed(2)}%`,
    `bookings made ${rate('bookings_made')}, refused by a rule ${rate('bookings_refused')}`,
    row('search', 'http_req_duration{name:search}'), row('free times', 'http_req_duration{name:slots}'), row('booking', 'http_req_duration{name:book}'),
    '', ...passed, '',
  ].join('\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = { stdout: text, [`/load/results/${PROFILE}-${stamp}.json`]: JSON.stringify(data, null, 1), [`/load/results/${PROFILE}-${stamp}.txt`]: text };
  if (data.setup_data?.sessions?.length) {
    const back = { ...DATA, patients: data.setup_data.sessions.map(({ id, phone, ip, refreshToken }) => ({ id, phone, ip, refreshToken })) };
    out[__ENV.DATA ?? '/load/.data/loadtest.json'] = JSON.stringify(back, null, 1);
  }
  return out;
}
