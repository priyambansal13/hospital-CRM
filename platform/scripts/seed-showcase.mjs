#!/usr/bin/env node
// `mc seed showcase`: a demo hospital with believable data for demos and screenshots (Aarogya Hospitals at
// aarogya.localhost:3400): branding, three branches, fourteen doctors across specialties with hours, fees, languages
// and bios. Everything goes through the normal APIs as the hospital's admin. Safe to run again: what exists is kept.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const SLUG = 'aarogya';
const HOST = `${SLUG}.localhost`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\x1b[36m[showcase]\x1b[0m ${m}`);

async function call(method, path, token, body) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': HOST, 'idempotency-key': crypto.randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
const waitFor = async (fn, ms = 60000, every = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every); } return undefined; };
const token = () => fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: `admin@${SLUG}.test`, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${SLUG}` }) }).then((r) => r.json()).then((j) => j.access_token);

// ---- the hospital ----
const tenants = await fetch('http://localhost:4401/internal/tenants', { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }).then((r) => r.json());
if (!tenants.some((t) => t.slug === SLUG)) {
  log('creating Aarogya Hospitals (Hospital Enterprise)');
  execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), 'tenant', 'create', SLUG, '--name', 'Aarogya Hospitals', '--admin', `admin@${SLUG}.test`, '--plan', 'HOSPITAL_ENTERPRISE'], { stdio: 'inherit' });
}
const admin = await waitFor(token, 120000, 2000);
if (!admin) throw new Error('the admin cannot sign in yet: run again in a minute');
await waitFor(async () => (await call('GET', '/api/entitlement/v1/public/modules')).modules?.includes('directory'), 120000, 2000);
await call('PATCH', '/api/tenant/v1/branding', admin, { primaryColor: '#0b6e99', accentColor: '#f59e0b' });

// ---- branches ----
const WANT = [
  { name: 'Gurugram, Sector 29', city: 'Gurugram', address: { line1: 'Plot 12, Sector 29 main road', pincode: '122001' } },
  { name: 'Noida, Sector 62', city: 'Noida', address: { line1: 'C-56, Institutional Area, Sector 62', pincode: '201309' } },
  { name: 'Dwarka, New Delhi', city: 'New Delhi', address: { line1: 'Sector 10, near Metro Station', pincode: '110075' } },
];
let branches = (await call('GET', '/api/tenant/v1/branches', admin)).list ?? [];
for (const b of WANT) if (!branches.some((x) => x.name === b.name)) await call('POST', '/api/tenant/v1/branches', admin, b);
branches = (await call('GET', '/api/tenant/v1/branches', admin)).list ?? [];
// by the short name the doctor list uses: Gurugram, Noida, Dwarka
const B = Object.fromEntries(WANT.map((w) => [w.name.split(',')[0], branches.find((x) => x.name === w.name)?.id]));
log(`branches: ${WANT.map((w) => w.name).join(' · ')}`);
// the provider directory learns branches from events
await waitFor(async () => (await call('GET', '/api/provider/v1/public/branches')).list?.length >= 3, 60000, 2000);

// ---- doctors ----
const D = [
  ['Dr. Ananya Sharma', 'FEMALE', 'CARDIOLOGY', ['MBBS', 'MD (Medicine)', 'DM (Cardiology)'], 16, ['en', 'hi'], 1200, ['Gurugram', 'Dwarka'], 'Interventional cardiologist: chest pain, heart failure and preventive cardiology.'],
  ['Dr. Rohan Mehta', 'MALE', 'CARDIOLOGY', ['MBBS', 'DNB (Cardiology)'], 11, ['en', 'hi', 'gu'], 1000, ['Noida'], 'Echocardiography and high blood pressure clinics.'],
  ['Dr. Kavya Iyer', 'FEMALE', 'DERMATOLOGY', ['MBBS', 'MD (Dermatology)'], 9, ['en', 'ta', 'hi'], 800, ['Gurugram', 'Noida'], 'Acne, eczema, hair loss and skin allergies.'],
  ['Dr. Arjun Nair', 'MALE', 'ORTHOPEDICS', ['MBBS', 'MS (Orthopaedics)'], 14, ['en', 'ml', 'hi'], 1000, ['Dwarka'], 'Knee and shoulder problems, sports injuries, joint replacement.'],
  ['Dr. Meera Kapoor', 'FEMALE', 'PEDIATRICS', ['MBBS', 'MD (Paediatrics)'], 12, ['en', 'hi', 'pa'], 700, ['Gurugram', 'Dwarka'], 'Newborn care, vaccination and childhood infections.'],
  ['Dr. Sameer Khan', 'MALE', 'GENERAL_MEDICINE', ['MBBS', 'MD (Medicine)'], 18, ['en', 'hi', 'ur'], 600, ['Gurugram', 'Noida', 'Dwarka'], 'Fever, diabetes, thyroid and everyday health problems.'],
  ['Dr. Priya Bhatt', 'FEMALE', 'GYNECOLOGY', ['MBBS', 'MS (Obstetrics & Gynaecology)'], 15, ['en', 'hi', 'gu'], 900, ['Noida'], 'Pregnancy care, PCOS and menstrual problems.'],
  ['Dr. Vikram Singh', 'MALE', 'NEUROLOGY', ['MBBS', 'MD (Medicine)', 'DM (Neurology)'], 13, ['en', 'hi'], 1200, ['Gurugram'], 'Headache and migraine, epilepsy, stroke follow-up.'],
  ['Dr. Neha Gupta', 'FEMALE', 'ENT', ['MBBS', 'MS (ENT)'], 8, ['en', 'hi'], 700, ['Dwarka', 'Noida'], 'Sinusitis, tonsils, ear infections and hearing problems.'],
  ['Dr. Aditya Rao', 'MALE', 'OPHTHALMOLOGY', ['MBBS', 'MS (Ophthalmology)'], 10, ['en', 'kn', 'hi'], 800, ['Gurugram'], 'Cataract, glasses and red-eye; diabetic eye checks.'],
  ['Dr. Farah Siddiqui', 'FEMALE', 'ENDOCRINOLOGY', ['MBBS', 'MD (Medicine)', 'DM (Endocrinology)'], 12, ['en', 'hi', 'ur'], 1100, ['Noida', 'Dwarka'], 'Diabetes, thyroid and hormone disorders.'],
  ['Dr. Karan Malhotra', 'MALE', 'GASTROENTEROLOGY', ['MBBS', 'MD (Medicine)', 'DM (Gastroenterology)'], 14, ['en', 'hi', 'pa'], 1100, ['Gurugram'], 'Acidity, liver disease, endoscopy.'],
  ['Dr. Ishita Banerjee', 'FEMALE', 'PSYCHIATRY', ['MBBS', 'MD (Psychiatry)'], 9, ['en', 'bn', 'hi'], 1000, ['Dwarka'], 'Anxiety, depression and sleep problems.'],
  ['Dr. Rahul Verma', 'MALE', 'DENTISTRY', ['BDS', 'MDS (Endodontics)'], 7, ['en', 'hi'], 500, ['Noida', 'Gurugram'], 'Root canal, fillings and braces.'],
];
const existing = new Set(((await call('GET', '/api/provider/v1/doctors?limit=100', admin)).items ?? []).map((d) => d.name));
let added = 0;
let failed = 0;
for (const [i, [name, gender, spec, qual, years, langs, fee, at, bio]] of D.entries()) {
  if (existing.has(name)) continue;
  const doc = await call('POST', '/api/provider/v1/doctors', admin, {
    name, gender, email: `${name.replace(/^Dr\. /, '').toLowerCase().replace(/\s+/g, '.')}@${SLUG}.test`, registrationNo: `DMC/${2010 + (i % 12)}/${41000 + i * 37}`,
    specialties: [{ code: spec, primary: true }], qualifications: qual, experienceYears: years, languages: langs, bio, consultModes: ['IN_PERSON', 'VIDEO'],
    branches: at.map((c) => ({ branchId: B[c], fee })),
  });
  if (doc.http !== 201) { log(`${name}: ${doc.code} ${doc.detail}`); failed++; continue; }
  await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'ACTIVE' });
  // mornings at the first branch, evenings at the second (if any), Monday to Saturday
  for (const [n, c] of at.slice(0, 2).entries()) {
    await waitFor(async () => (await call('POST', `/api/scheduling/v1/doctors/${doc.id}/availability`, admin, { days: [1, 2, 3, 4, 5, 6], branchId: B[c], startTime: n === 0 ? '09:30' : '17:00', endTime: n === 0 ? '13:30' : '20:00', slotMinutes: 15 })).http < 300, 30000, 1000);
  }
  added++;
}
log(`doctors: ${added} added, ${D.length - added - failed} already there${failed ? `, ${failed} failed` : ''}`);
await waitFor(async () => ((await call('GET', '/api/search/v1/public/search/doctors?limit=50')).items?.length ?? 0) >= D.length, 90000, 3000);
log(`ready: http://${HOST}:3400 (admin@${SLUG}.test, the dev staff password)`);
