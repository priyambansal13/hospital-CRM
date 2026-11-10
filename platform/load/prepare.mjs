#!/usr/bin/env node
// `mc load prepare`: the hospital the load test runs against (never a demo or test hospital): "loadtest", Hospital
// Enterprise, two branches, DOCTORS doctors with a normal week of hours, and PATIENTS patients signed
// in by OTP. Writes platform/load/.data/<slug>.json (patients' refresh tokens, doctor ids, search words) for the k6
// script. Safe to run again: what exists is kept, patients are topped up.
// Doctors work Monday to Saturday, 09:00–13:00 and 17:00–20:30 in 15-minute slots (like the demo hospital).
//   LOAD_DOCTORS (40)  LOAD_PATIENTS (200)  LOAD_SLUG (loadtest)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const SLUG = process.env.LOAD_SLUG ?? 'loadtest';
const HOST = `${SLUG}.localhost`;
const DOCTORS = Number(process.env.LOAD_DOCTORS ?? 40);
const PATIENTS = Number(process.env.LOAD_PATIENTS ?? 200);
const OUT = join(PLATFORM, 'load/.data', `${SLUG}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\x1b[36m[load]\x1b[0m ${m}`);

async function call(method, path, token, body, ip) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': HOST, 'idempotency-key': crypto.randomUUID(), ...(ip ? { 'x-forwarded-for': ip } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
const waitFor = async (fn, ms = 60000, every = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every); } return undefined; };
const token = () => fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: `admin@${SLUG}.test`, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${SLUG}` }) }).then((r) => r.json()).then((j) => j.access_token);
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
/** Runs fn over items, `n` at a time. */
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---- the hospital
const tenants = await fetch('http://localhost:4401/internal/tenants', { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }).then((r) => r.json());
if (!tenants.some((t) => t.slug === SLUG)) {
  log(`creating ${SLUG} (Hospital Enterprise)`);
  execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), 'tenant', 'create', SLUG, '--name', 'Load Test Hospital', '--admin', `admin@${SLUG}.test`, '--plan', 'HOSPITAL_ENTERPRISE'], { stdio: 'inherit' });
}
// staff tokens last 5 minutes and preparing can take longer: a fresh one every 4
let adminToken = await waitFor(token, 120000, 2000);
if (!adminToken) throw new Error('the admin cannot sign in yet: run again in a minute');
let adminAt = Date.now();
const adm = async () => { if (Date.now() - adminAt > 240_000) { adminToken = await token(); adminAt = Date.now(); } return adminToken; };
await waitFor(async () => (await call('GET', '/api/entitlement/v1/public/modules')).modules?.includes('directory'), 120000, 2000);

const WANT = [{ name: 'Load Central', city: 'Pune', address: { line1: '1 Test Road', pincode: '411001' } }, { name: 'Load East', city: 'Pune', address: { line1: '2 Test Road', pincode: '411014' } }];
let branches = (await call('GET', '/api/tenant/v1/branches', await adm())).list ?? [];
for (const b of WANT) if (!branches.some((x) => x.name === b.name)) await call('POST', '/api/tenant/v1/branches', await adm(), b);
branches = ((await call('GET', '/api/tenant/v1/branches', await adm())).list ?? []).filter((b) => WANT.some((w) => w.name === b.name));
await waitFor(async () => (await call('GET', '/api/provider/v1/public/branches')).list?.length >= 2, 60000, 2000);

// ---- doctors: open every day, long hours, so a morning rush never runs out of times
const SPECIALTIES = ['CARDIOLOGY', 'DERMATOLOGY', 'ORTHOPEDICS', 'PEDIATRICS', 'GENERAL_MEDICINE', 'GYNECOLOGY', 'NEUROLOGY', 'ENT', 'OPHTHALMOLOGY', 'ENDOCRINOLOGY'];
const FIRST = ['Asha', 'Ravi', 'Meena', 'Kiran', 'Sunil', 'Pooja', 'Anil', 'Divya', 'Rahul', 'Sneha', 'Vivek', 'Nisha', 'Arun', 'Lata', 'Manoj', 'Rekha', 'Ajay', 'Kavita', 'Deepak', 'Usha'];
const LAST = ['Load', 'Rush', 'Peak', 'Burst'];
const have = new Set(((await call('GET', `/api/provider/v1/doctors?limit=100`, await adm())).items ?? []).map((d) => d.name));
let added = 0;
await pool(Array.from({ length: DOCTORS }, (_, i) => i), 4, async (i) => {
  const name = `Dr. ${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]} ${i}`;
  if (have.has(name)) return;
  const b = branches[i % branches.length];
  const doc = await call('POST', '/api/provider/v1/doctors', await adm(), {
    name, gender: i % 2 ? 'MALE' : 'FEMALE', email: `doctor${i}@${SLUG}.test`, registrationNo: `LOAD/${2000 + i}`, specialties: [{ code: SPECIALTIES[i % SPECIALTIES.length], primary: true }],
    qualifications: ['MBBS', 'MD'], experienceYears: 5 + (i % 20), languages: ['en', 'hi'], bio: 'Synthetic doctor for load tests.', consultModes: ['IN_PERSON'], branches: [{ branchId: b.id, fee: 500 + (i % 6) * 100 }],
  });
  if (doc.http !== 201) { log(`${name}: ${doc.code} ${doc.detail}`); return; }
  await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, await adm(), { status: 'ACTIVE' });
  added++;
});
// every published doctor gets a real doctor's week (as Aarogya's): Monday to Saturday, a morning and an evening in
// 15-minute slots, so the free-times list a patient loads is the size it is in production
const WEEK = [{ startTime: '09:00', endTime: '13:00' }, { startTime: '17:00', endTime: '20:30' }];
const published = (await call('GET', '/api/provider/v1/public/doctors?limit=50')).items ?? [];
let hours = 0;
await pool(published, 4, async (d) => {
  const sched = await call('GET', `/api/scheduling/v1/doctors/${d.id}/schedule`, await adm());
  const now = sched.hours ?? [];
  const right = now.length === 12 && now.every((h) => WEEK.some((w) => h.startTime.startsWith(w.startTime)) && h.dayOfWeek <= 6);
  if (right) return;
  for (const h of now) await call('DELETE', `/api/scheduling/v1/doctors/${d.id}/availability/${h.id}`, await adm());
  const branchId = sched.branches?.[0]?.id ?? branches[0].id;
  for (const w of WEEK) await waitFor(async () => (await call('POST', `/api/scheduling/v1/doctors/${d.id}/availability`, await adm(), { days: [1, 2, 3, 4, 5, 6], branchId, ...w, slotMinutes: 15 })).http < 300, 60000, 2000);
  hours++;
});
const doctors = published.map((d) => d.id);
log(`doctors: ${added} added, ${doctors.length} published, weekly hours set for ${hours}`);

// ---- patients, signed in by OTP (each from its own address, like real phones)
const saved = (() => { try { return JSON.parse(readFileSync(OUT, 'utf8')); } catch { return { patients: [] }; } })();
const alive = (await pool(saved.patients ?? [], 10, async (p) => {
  const r = await call('POST', '/api/iam/v1/auth/refresh', null, { refreshToken: p.refreshToken }, p.ip);
  return r.refreshToken ? { ...p, refreshToken: r.refreshToken } : null;
})).filter(Boolean);
const need = Math.max(0, PATIENTS - alive.length);
const SFX = Date.now().toString().slice(-5);
const fresh = (await pool(Array.from({ length: need }, (_, i) => i), 8, async (i) => {
  const phone = `+9184${SFX}${String(i).padStart(3, '0')}`;
  const ip = `10.77.${Math.floor(i / 250)}.${(i % 250) + 1}`;
  const since = Date.now();
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone }, ip);
  const code = await waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => Date.parse(m.Created) >= since - 2000 && /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6), 30000, 700);
  if (!code) return null;
  const v = await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code }, ip);
  if (!v.accessToken) return null;
  const me = await call('PUT', '/api/patient/v1/me/profile', v.accessToken, { fullName: `Load Patient ${SFX}${i}`, dob: '1990-01-01', gender: i % 2 ? 'MALE' : 'FEMALE' }, ip);
  return me.id ? { id: me.id, phone, ip, refreshToken: v.refreshToken } : null;
})).filter(Boolean);
const patients = [...alive, ...fresh];
log(`patients: ${alive.length} kept, ${fresh.length} added (${need - fresh.length} could not sign in)`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ slug: SLUG, host: HOST, doctors, patients, words: ['chest pain', 'skin', 'knee', 'child fever', 'diabetes', 'cardiology', 'eye', 'headache', 'ear', 'thyroid', 'Asha', 'Ravi', 'pregnancy', 'back pain'] }, null, 1));
log(`wrote ${OUT} (${doctors.length} doctors, ${patients.length} patients)`);
