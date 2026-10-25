#!/usr/bin/env node
// Search (Phase 21), against the local gateway and search-service:
//   two new cardiologists at City Care (one free in 2 days, one in 5) → "chest pain" finds only cardiologists, the
//   sooner one first → booking a slot moves "next available", cancelling moves it back → typos, paging, filters →
//   "sugar test" finds HbA1c and fasting sugar → each hospital only ever sees its own index → a hospital without the
//   lab gets no test search → the patient zone falls back to the directory when search is unavailable, and comes
//   back once it is rebuilt → unpublished doctors leave the index. The two doctors are unpublished at the end.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const SEARCH = 'http://localhost:4414';
const OS = 'http://localhost:61920';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const HOST = 'citycare.localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host = HOST) {
  const r = await fetch(G + path, { method, headers: { ...(host ? { 'x-tenant-host': host } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
async function staffToken(email, slug) {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const internal = (method, path) => fetch(SEARCH + path, { method, headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }).then((r) => r.json());
const waitFor = async (fn, ms = 30000, every = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
const tenants = () => fetch('http://localhost:4401/internal/tenants', { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }).then((r) => r.json());
const doctors = (q, host = HOST) => call('GET', `/api/search/v1/public/search/doctors?${new URLSearchParams(q)}`, null, undefined, host);
const tests = (q, host = HOST) => call('GET', `/api/search/v1/public/search/tests?q=${encodeURIComponent(q)}`, null, undefined, host);
const dayPlus = (n) => new Date(Date.now() + n * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
/** The patient zone's doctor page, as a browser on the hospital's address gets it. */
const zonePage = (q) => execFileSync('curl', ['-s', '-H', `Host: ${HOST}:3400`, `http://localhost:3400/care/doctors?q=${encodeURIComponent(q)}`], { encoding: 'utf8' });

async function patient() {
  const phone = `+9197${String(Date.now()).slice(-8)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const code = await waitFor(async () => {
    const m = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.slice(1)}@sms.medicare.local`)}`)).json();
    return m.messages?.[0]?.Snippet?.match(/\d{6}/)?.[0];
  }, 10000, 300);
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
  const me = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: 'Search Patient', dob: '1988-03-03' });
  return { token, patientId: me.id };
}

const all = await tenants();
const city = all.find((t) => t.slug === 'citycare');
const sunrise = all.find((t) => t.slug === 'sunrise');
const SFX = Date.now().toString().slice(-5);

// ---- 0. the engine and the indexes
const st = await internal('GET', `/internal/tenants/${city.id}/search`);
check(st.engine === 'green' || st.engine === 'yellow', `search engine up (${st.engine})`);
check(st.indexes?.length === 2 && st.indexes.every((i) => i.current), `City Care indexes current: ${st.indexes?.map((i) => `${i.kind} ${i.documents}`).join(', ')}`);

// ---- 1. two new cardiologists; the directory publishes them, search picks them up from the events
let admin = await staffToken('admin@citycare.test', 'citycare');
const branch = (await call('GET', '/api/provider/v1/public/branches', null)).list[0];
const mk = async (name, email) => {
  const d = await call('POST', '/api/provider/v1/doctors', admin, { name, email, registrationNo: `KMC/S${SFX}${email[0]}`, specialties: [{ code: 'CARDIOLOGY', primary: true }], branches: [{ branchId: branch.id, fee: 900 }], consultModes: ['IN_PERSON'], languages: ['en', 'hi'] });
  await call('POST', `/api/provider/v1/doctors/${d.id}/status`, admin, { status: 'ACTIVE' });
  return d;
};
const later = await mk(`Dr. Ishaan Kapoor ${SFX}`, `ishaan.${SFX}@example.test`);
const sooner = await mk(`Dr. Ritu Bhatt ${SFX}`, `ritu.${SFX}@example.test`);
check(later.http === 201 && sooner.http === 201, `two cardiologists published: ${later.name}, ${sooner.name}`);
const inIndex = await waitFor(async () => { const r = await doctors({ q: SFX }); return r.items?.length === 2 ? r : null; }, 30000);
check(!!inIndex, 'both are searchable within seconds of being published (provider.doctor_created/updated events)');
check(inIndex?.items.every((d) => d.nextAvailableAt === null), 'no hours yet: no "next available"');

// ---- 2. hours: Ritu from the day after tomorrow, Ishaan from in 5 days → slot events set "next available"
await call('POST', `/api/scheduling/v1/doctors/${later.id}/availability`, admin, { days: [1, 2, 3, 4, 5, 6, 7], branchId: branch.id, startTime: '09:00', endTime: '13:00', slotMinutes: 15, effectiveFrom: dayPlus(5) });
await call('POST', `/api/scheduling/v1/doctors/${sooner.id}/availability`, admin, { days: [1, 2, 3, 4, 5, 6, 7], branchId: branch.id, startTime: '09:00', endTime: '13:00', slotMinutes: 15, effectiveFrom: dayPlus(2) });
const timed = await waitFor(async () => { const r = await doctors({ q: SFX }); return r.items?.every((d) => d.nextAvailableAt) ? r : null; }, 45000);
const nextOf = (r, id) => r?.items.find((d) => d.id === id)?.nextAvailableAt;
check(!!timed, `"next available" from scheduling.availability_changed: Ritu ${nextOf(timed, sooner.id)}, Ishaan ${nextOf(timed, later.id)}`);
check(timed && nextOf(timed, sooner.id).slice(0, 10) === dayPlus(2) && nextOf(timed, later.id).slice(0, 10) === dayPlus(5), 'first open slots are on the days the hours start');

// ---- 3. the demo: "chest pain" → cardiologists only, whoever is free soonest first
const chest = await doctors({ q: 'chest pain', limit: '50' });
const names = chest.items?.map((d) => d.name) ?? [];
check(chest.http === 200 && chest.items.length >= 2 && chest.items.every((d) => d.specialties.some((s) => s.code === 'CARDIOLOGY')), `"chest pain" → ${chest.items?.length} doctors, all cardiologists: ${names.join(', ')}`);
const times = chest.items?.map((d) => d.nextAvailableAt ?? '9999') ?? [];
check(times.every((t, i) => i === 0 || times[i - 1] <= t), 'sorted by next available slot (doctors without hours last)');
check(names.indexOf(sooner.name) < names.indexOf(later.name), `${sooner.name} (sooner) before ${later.name}`);
const directory = await call('GET', '/api/provider/v1/public/doctors?q=chest%20pain', null);
check(directory.items?.length === 0, 'the directory\'s own name search finds nobody for "chest pain" (why search exists)');
for (const [q, code] of [['palpitations', 'CARDIOLOGY'], ['heart specialist', 'CARDIOLOGY'], ['skin rash', 'DERMATOLOGY'], ['toothache', 'DENTISTRY'], ['fever', 'GENERAL_MEDICINE']]) {
  const r = await doctors({ q });
  check(r.http === 200 && (r.items.length === 0 || r.items.every((d) => d.specialties.some((s) => s.code === code))) && (code !== 'CARDIOLOGY' || r.items.length > 0), `"${q}" → ${code} only (${r.items?.length})`);
}

// ---- 4. booking takes Ritu's first slot → her next available moves; cancelling gives it back
const p = await patient();
const first = (await call('GET', `/api/scheduling/v1/public/doctors/${sooner.id}/slots?days=7`, null)).days.find((d) => d.slots.length).slots[0];
const before = nextOf(timed, sooner.id);
const appt = await call('POST', '/api/scheduling/v1/appointments', p.token, { slotId: first.slotId, patientId: p.patientId });
const moved = await waitFor(async () => { const n = nextOf(await doctors({ q: SFX }), sooner.id); return n && n > before ? n : null; }, 30000);
check(appt.http === 201 && !!moved, `booked ${appt.appointmentNo}: Ritu's next available ${before} → ${moved} (scheduling.appointment_booked)`);
await call('POST', `/api/scheduling/v1/appointments/${appt.id}/cancel`, p.token, { reason: null });
const back = await waitFor(async () => nextOf(await doctors({ q: SFX }), sooner.id) === before, 30000);
check(!!back, 'cancelled: the slot is free again and so is "next available"');

// ---- 5. names with typos, filters, paging
const typo = await doctors({ q: `ishan kapor` });
check(typo.items?.some((d) => d.id === later.id), `"ishan kapor" (typos) finds ${later.name}`);
const mixed = await doctors({ q: `cardiology ritu` });
check(mixed.items?.[0]?.id === sooner.id, '"cardiology ritu": words across name and specialty');
const hindi = await doctors({ q: 'chest pain', language: 'hi' });
check(hindi.items?.every((d) => d.languages.includes('hi')) && hindi.items.some((d) => d.id === sooner.id), 'filters still apply (Hindi-speaking)');
const filtered = await doctors({ q: 'chest pain', specialty: 'DERMATOLOGY' });
check(filtered.items?.length === 0, 'symptom + another specialty filter → nothing');
const p1 = await doctors({ limit: '5' });
const p2 = p1.nextCursor ? await doctors({ limit: '5', cursor: p1.nextCursor }) : { items: [] };
check(p1.items?.length === 5 && p2.items?.length > 0 && !p2.items.some((d) => p1.items.some((x) => x.id === d.id)), `paging: ${p1.items?.length} + ${p2.items?.length}, no repeats`);
check((await doctors({ cursor: 'garbage' })).http === 400, 'a bad cursor is refused');

// ---- 6. tests: everyday words → the right tests
const sugar = await tests('sugar test');
const sugarCodes = sugar.tests?.map((t) => t.code) ?? [];
check(sugarCodes.includes('HBA1C') && sugarCodes.includes('FBS'), `"sugar test" → ${sugar.tests?.map((t) => t.name).join(', ')}; packages ${sugar.packages?.map((x) => x.name).join(', ')}`);
check(sugar.packages?.some((x) => x.code === 'DIABETES'), '…and the diabetes package');
const chol = await tests('cholesterol');
check(chol.tests?.[0]?.code === 'LIPID', `"cholesterol" → ${chol.tests?.[0]?.name}`);
const vit = await tests('vitmin d');
check(vit.tests?.[0]?.code === 'VITD', `"vitmin d" (typo) → ${vit.tests?.[0]?.name}`);

// ---- 7. isolation: another hospital's host only ever reaches its own index
const sun = await doctors({ q: 'chest pain' }, 'sunrise.localhost');
check(sun.http === 200 && !sun.items.some((d) => chest.items.some((x) => x.id === d.id)), `Sunrise "chest pain": ${sun.items?.length} doctors, none of City Care's`);
const sunBySfx = await doctors({ q: SFX }, 'sunrise.localhost');
check(sunBySfx.items?.length === 0, 'City Care\'s new doctors are not in Sunrise\'s search');
const sunTests = await tests('sugar test', 'sunrise.localhost');
check(sunTests.http !== 200 || !sunTests.tests.some((t) => sugar.tests.some((x) => x.id === t.id)), 'Sunrise\'s tests are its own (different ids)');
check((await doctors({ q: 'x' }, 'nobody.localhost')).http === 404, 'an unknown hospital address gets nothing');
const noLab = [];
for (const t of all.filter((x) => x.status === 'ACTIVE' && x.id !== city.id)) {
  const host = `${t.slug}.localhost`;
  if ((await call('GET', '/api/diagnostics/v1/public/lab-catalog', null, undefined, host)).http === 403) noLab.push([t.slug, (await tests('sugar', host)).http]);
}
check(noLab.length > 0 && noLab.every(([, s]) => s === 403), `hospitals without the lab get no test search (${noLab.map(([s, h]) => `${s} ${h}`).join(', ')})`);

// ---- 8. fallback: the index is gone → search says 503 → the patient zone uses the directory; rebuilt → search again
check(zonePage('chest pain').includes('data-source="search"') && zonePage('chest pain').includes(sooner.name), 'patient zone: "chest pain" served by search, shows the new cardiologist');
await fetch(`${OS}/${env.SEARCH_INDEX_PREFIX ?? 'mc-dev'}-${city.id}-doctors`, { method: 'DELETE' });
check((await doctors({ q: 'asha' })).http === 503, 'index missing → 503 SEARCH_UNAVAILABLE');
const fb = zonePage('asha');
check(fb.includes('data-source="directory"') && fb.includes('Dr. Asha Rao'), 'patient zone falls back to the directory: "asha" still finds Dr. Asha Rao');
const re = await internal('POST', `/internal/tenants/${city.id}/search/reindex`);
check(re.rebuilt?.includes('doctors') && re.doctors > 0, `rebuilt: ${re.doctors} doctors, ${re.tests} tests (index version ${re.version})`);
check(zonePage('chest pain').includes('data-source="search"'), 'patient zone is back on search');

// ---- 9. unpublished → out of search
admin = await staffToken('admin@citycare.test', 'citycare');
for (const d of [later, sooner]) await call('POST', `/api/provider/v1/doctors/${d.id}/status`, admin, { status: 'INACTIVE' });
const gone = await waitFor(async () => (await doctors({ q: SFX })).items?.length === 0, 30000);
check(!!gone, 'unpublished doctors leave search (clean-up)');

console.log(failures ? `\n\x1b[31msearch: ${failures} failed\x1b[0m` : '\n\x1b[32msearch ok\x1b[0m');
process.exit(failures ? 1 : 0);
