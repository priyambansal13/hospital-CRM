#!/usr/bin/env node
// MediCare's marketing site and funnel, and hospitals' own search and campaigns (docs/SEO-AND-ADS.md), against the
// local stack and the web zones:
//   the marketing pages answer on MediCare's host only, each with its own title and canonical, in the sitemap and
//   allowed by robots.txt, with FAQ and Article data → the sharing card per host → a demo request becomes a lead for
//   sales (with where it came from; ad click ids only with consent), which only MediCare's console sees, and the
//   Google Ads file lists consented conversions only → a hospital's branch area and description reach its pages and
//   search data, a renamed branch's old address redirects → a doctor's photo shows on the profile → an online booking
//   made from a campaign link records it, and analytics shows bookings by campaign.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const WEB = (host) => `http://${host}:3400`;
const M = 'medicare.localhost';
const A = 'aarogya.localhost';
const C = 'citycare.localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
const waitFor = async (fn, ms = 30000, every = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };
const SFX = Date.now().toString().slice(-6);
const LETTERS = SFX.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);

async function call(method, path, token, body, host = C) {
  const go = () => fetch(G + path, { method, headers: { 'x-tenant-host': host, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  const r = await go().catch(() => go());
  const raw = r.status === 204 ? '' : await r.text();
  let j = {};
  try { j = raw ? JSON.parse(raw) : {}; } catch { j = { text: raw }; }
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
async function staffToken(email, slug) {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const mail = async (q) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];
async function patient(host) {
  const phone = `+9186${SFX}${String(Math.floor(Math.random() * 90) + 10)}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone }, host);
  const code = await waitFor(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6), 20000, 500);
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code }, host)).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', token, { fullName: `Growth Test ${LETTERS}`, dob: '1990-05-05', gender: 'FEMALE' }, host);
  return { token, id: self.id };
}
const psql = (db, sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
/** A web page as a crawler gets it: no cookies, redirects not followed. */
async function page(url) {
  const get = () => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
  const r = await get().catch(() => get());
  const html = r.status === 200 ? await r.text() : '';
  const attr = (re) => re.exec(html)?.[1]?.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"') ?? null;
  return {
    status: r.status, location: r.headers.get('location'), html,
    title: attr(/<title>([^<]*)<\/title>/), description: attr(/<meta name="description" content="([^"]*)"/),
    robots: attr(/<meta name="robots" content="([^"]*)"/), canonical: attr(/<link rel="canonical" href="([^"]*)"/),
    image: attr(/<meta property="og:image" content="([^"]*)"/),
    ld: [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].flatMap((m) => { try { return [JSON.parse(m[1])].flat(); } catch { return [{ '@type': 'INVALID' }]; } }),
  };
}
const text = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(120_000) }); return { status: r.status, body: await r.text(), type: r.headers.get('content-type') }; };
function robotsAllows(robots, path) {
  const rules = robots.split('\n').map((l) => /^(Allow|Disallow):\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => ({ allow: m[1] === 'Allow', path: m[2] }));
  const matches = rules.filter((r) => r.path && (r.path.endsWith('$') ? path === r.path.slice(0, -1) : path.startsWith(r.path)));
  if (!matches.length) return true;
  matches.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return matches[0].allow;
}

// ---- 1. the marketing site
const MKT = ['/features', '/features/online-booking', '/features/lab', '/for/clinics', '/for/diagnostic-centres', '/security', '/resources', '/resources/cut-opd-no-shows', '/demo', '/pricing'];
const got = Object.fromEntries(await Promise.all(MKT.map(async (p) => [p, await page(WEB(M) + p)])));
const pages = Object.entries(got);
check(pages.every(([, p]) => p.status === 200), `marketing pages answer: ${pages.filter(([, p]) => p.status !== 200).map(([k, p]) => `${k} ${p.status}`).join(', ') || 'all 200'}`);
check(new Set(pages.map(([, p]) => p.title)).size === pages.length && pages.every(([k, p]) => p.canonical === WEB(M) + k && p.robots === 'index, follow'), 'each has its own title, is its own canonical and may be indexed');
check(pages.every(([, p]) => p.description && p.description.length >= 50 && p.description.length <= 160), 'each has a description of search-result length');
check(got['/pricing'].ld.some((x) => x['@type'] === 'FAQPage' && x.mainEntity.length >= 5) && got['/resources/cut-opd-no-shows'].ld.some((x) => x['@type'] === 'Article' && x.datePublished), 'pricing has FAQ data and a guide has Article data');
check(pages.every(([, p]) => p.ld.some((x) => x['@type'] === 'BreadcrumbList') || p.ld.some((x) => x['@type'] === 'FAQPage') || !p.ld.length) && !pages.some(([, p]) => p.ld.some((x) => x['@type'] === 'INVALID')), 'structured data parses');
check(!/Diagnostic Center – Professional.*Diagnostic Center – Professional/s.test(got['/features/lab'].html), 'a feature page lists each plan once');
const onHospital = await Promise.all(['/features', '/for/clinics', '/security', '/resources', '/demo'].map((p) => page(WEB(A) + p)));
check(onHospital.every((p) => p.status === 404), "the marketing pages don't exist on a hospital's host");
const mMap = await text(`${WEB(M)}/sitemap.xml`);
const mRobots = (await text(`${WEB(M)}/robots.txt`)).body;
check(MKT.every((p) => mMap.body.includes(`<loc>${WEB(M)}${p}</loc>`)) && MKT.every((p) => robotsAllows(mRobots, p)), 'every marketing page is in the sitemap and open to crawlers');
check(['/demo/thanks', '/login', '/signup/status', '/platform', '/account'].every((p) => !robotsAllows(mRobots, p)) && (await page(`${WEB(M)}/demo/thanks`)).robots === 'noindex, nofollow', 'the thank-you page, sign-in, signup progress and the console are kept out');
const home = await page(`${WEB(M)}/`);
check(!/googletagmanager|fbevents/.test(home.html) && !(await fetch(`${WEB(M)}/`)).headers.get('set-cookie'), 'no ad tags or cookies before consent (the banner asks in the browser)');
const aHome = await page(`${WEB(A)}/`);
check(!/googletagmanager|fbevents|connect\.facebook/.test(aHome.html + (await page(`${WEB(A)}/care/doctors`)).html), "no ad tags anywhere on a hospital's pages");

// ---- 2. the sharing card
const ogA = await fetch(`${WEB(A)}/og.png`);
const ogM = await fetch(`${WEB(M)}/og.png`);
check(ogA.status === 200 && ogA.headers.get('content-type') === 'image/png' && ogM.status === 200, 'a sharing card per host (/og.png)');
check(aHome.image === `${WEB(A)}/og.png` && robotsAllows((await text(`${WEB(A)}/robots.txt`)).body, '/og.png'), 'pages share the card unless they have their own image, and crawlers may fetch it');

// ---- 3. demo requests and the console
const support = await staffToken('support@medicare.test', 'medicare');
const product = await staffToken('product@medicare.test', 'medicare');
const aAdmin = await staffToken('admin@aarogya.test', 'aarogya');
const lead = (o) => call('POST', '/api/tenant/v1/leads', null, { name: 'Dr Neha Growth', email: `neha.${SFX}${o.n}@example.test`, phone: null, hospitalName: `Growth Clinic ${LETTERS}${o.n}`, city: 'Pune', segment: 'CLINIC', doctors: 4, message: null, attribution: o.attribution }, M);
const l1 = await lead({ n: 1, attribution: { source: 'google', medium: 'cpc', campaign: `test-${SFX}`, gclid: `NOCONSENT${SFX}`, landing: '/for/clinics', consent: false } });
const l2 = await lead({ n: 2, attribution: { source: 'google', medium: 'cpc', campaign: `test-${SFX}`, gclid: `CONSENT${SFX}`, consent: true } });
const l3 = await lead({ n: 3, attribution: { campaign: '<script>', landing: 'https://evil.example', consent: 'yes' } });
check(l1.http === 201 && l2.http === 201 && l3.http === 201, 'demo requests are taken (a damaged attribution is dropped, not refused)');
check((await call('POST', '/api/tenant/v1/leads', null, { name: 'x', email: 'bad', hospitalName: '', segment: 'NOPE' }, M)).http === 400, 'an invalid request is refused');
const leads = await call('GET', '/api/tenant/v1/platform/growth/leads', support, undefined, M);
const mine = leads.list?.filter((l) => l.hospitalName.startsWith(`Growth Clinic ${LETTERS}`)) ?? [];
check(mine.length === 3 && mine.find((l) => l.id === l1.id)?.channel.campaign === `test-${SFX}` && mine.find((l) => l.id === l1.id)?.landing === '/for/clinics' && mine.find((l) => l.id === l3.id)?.channel.source === 'direct', `sales sees the requests with where they came from (${mine.length})`);
const stored = psql('mc_control', `SELECT string_agg(attribution::text, '|' ORDER BY created_at) FROM tenant.leads WHERE hospital_name LIKE 'Growth Clinic ${LETTERS}%'`);
check(!stored.includes(`NOCONSENT${SFX}`) && stored.includes(`CONSENT${SFX}`) && !stored.includes('script'), 'ad click ids are kept only with consent');
const upd = await call('PATCH', `/api/tenant/v1/platform/growth/leads/${l1.id}`, support, { status: 'CONTACTED', note: 'Called, demo on Friday' }, M);
check(upd.status === 'CONTACTED' && (await call('PATCH', `/api/tenant/v1/platform/growth/leads/${l1.id}`, product, { status: 'WON' }, M)).http === 403, 'support updates a request; the product team can only read');
const notice = await waitFor(async () => (await mail(`to:support@medicare.test subject:"Demo request: Growth Clinic ${LETTERS}1"`)).length > 0, 60000, 2000);
check(!!notice, 'MediCare support is told about a new demo request');
const funnel = await call('GET', '/api/tenant/v1/platform/growth/funnel?days=30', product, undefined, M);
const line = funnel.rows?.find((r) => r.campaign === `test-${SFX}`);
check(line?.leads === 2 && line.source === 'google' && line.medium === 'cpc', `the funnel groups by campaign (google / cpc / test-${SFX}: ${line?.leads} requests)`);
const csv = await fetch(`${G}/api/tenant/v1/platform/growth/conversions/google.csv?days=1`, { headers: { 'x-tenant-host': M, authorization: `Bearer ${support}` } });
const csvText = await csv.text();
check(csv.status === 200 && csvText.startsWith('Parameters:TimeZone=Asia/Calcutta\nGoogle Click ID,Email,Conversion Name') && csvText.includes(`CONSENT${SFX},`) && !csvText.includes(`NOCONSENT${SFX}`) && !csvText.includes('@example.test'), 'the Google Ads file has consented conversions only, e-mails hashed');
check([403, 404].includes((await call('GET', '/api/tenant/v1/platform/growth/leads', aAdmin, undefined, A)).http) && (await call('GET', '/api/tenant/v1/platform/growth/leads', null, undefined, M)).http === 401, "a hospital's admin and anonymous callers can't see MediCare's leads");
const run = await call('POST', '/api/tenant/internal/growth/run', null, undefined, M);
check(run.http === 404 || run.http === 403 || run.http === 401, 'the growth job is internal only (not reachable through the gateway)');

// ---- 4. a hospital's search settings: branch area, rename, description, doctor photo
const noidaId = (await call('GET', '/api/tenant/v1/public/branches', null, undefined, A)).list.find((b) => b.slug === 'noida-sector-62').id;
const noida = await call('GET', `/api/tenant/v1/branches/${noidaId}`, aAdmin, undefined, A);
const NAME = noida.name;
try {
  const set = await call('PATCH', `/api/tenant/v1/branches/${noida.id}`, aAdmin, { area: 'Sector 62, Noida', version: noida.version }, A);
  check(set.area === 'Sector 62, Noida' && set.name === NAME, 'an admin sets the area a branch serves');
  const bp = await page(`${WEB(A)}/care/branches/noida-sector-62`);
  check(/Sector 62, Noida/.test(bp.title) && bp.ld.some((x) => x.areaServed === 'Sector 62, Noida'), `the area is in the branch's title and data: "${bp.title}"`);
  const ren = await call('PATCH', `/api/tenant/v1/branches/${noida.id}`, aAdmin, { name: `${NAME} ${LETTERS}`, version: set.version }, A);
  const newSlug = `noida-sector-62-${LETTERS}`;
  const old = await page(`${WEB(A)}/care/branches/noida-sector-62`);
  check(ren.http === 200 && old.status === 308 && old.location === `${WEB(A)}/care/branches/${newSlug}`, `renamed: the old address redirects to the new one (${old.status} → ${old.location})`);
  check((await page(`${WEB(A)}/care/branches/${newSlug}`)).status === 200 && (await page(`${WEB(C)}/care/branches/noida-sector-62`)).status === 404, "the new address answers, and the old one doesn't exist on another hospital's host");
  const back = await call('PATCH', `/api/tenant/v1/branches/${noida.id}`, aAdmin, { name: NAME, area: null, version: ren.version }, A);
  const restored = await page(`${WEB(A)}/care/branches/noida-sector-62`);
  const interim = await page(`${WEB(A)}/care/branches/${newSlug}`);
  check(back.http === 200 && restored.status === 200 && interim.status === 308 && interim.location === `${WEB(A)}/care/branches/noida-sector-62`, 'renamed back: the original address is current again, the interim one redirects to it');
} finally {
  const now = (await call('GET', `/api/tenant/v1/branches/${noida.id}`, aAdmin, undefined, A));
  if (now.name !== NAME || now.area) await call('PATCH', `/api/tenant/v1/branches/${noida.id}`, aAdmin, { name: NAME, area: null, version: now.version }, A);
}

const cAdmin = await staffToken('admin@citycare.test', 'citycare');
const before = (await call('GET', '/api/tenant/v1/public/branding', null, undefined, C)).branding?.description ?? null;
const words = `City Care Clinic in Bengaluru: family doctors, children's care and a lab, open seven days (${SFX}).`;
await call('PATCH', '/api/tenant/v1/branding', cAdmin, { description: words }, C);
const ch = await page(`${WEB(C)}/`);
check(ch.description === words && ch.ld.some((x) => x['@type'] === 'MedicalOrganization' && x.description === words) && ch.html.includes(words.replace(/'/g, '&#x27;')), "the hospital's own description is on its home page and in search data");
await call('PATCH', '/api/tenant/v1/branding', cAdmin, { description: before }, C);

const asha = (await call('GET', '/api/provider/v1/doctors?q=asha&limit=5', cAdmin)).items?.find((d) => d.email === 'asha.rao@citycare.test');
const photo = `https://images.example.test/doctors/asha-${SFX}.jpg`;
try {
  const p1 = await call('PATCH', `/api/provider/v1/doctors/${asha.id}`, cAdmin, { photoUrl: photo, version: asha.version });
  check(p1.http === 200 && (await call('PATCH', `/api/provider/v1/doctors/${asha.id}`, cAdmin, { photoUrl: 'javascript:alert(1)', version: p1.version })).http === 400, 'an admin sets a doctor\'s photo (https links only)');
  const dp = await waitFor(async () => { const p = await page(`${WEB(C)}/care/doctors/${asha.slug}`); return p.html.includes(photo) ? p : null; }, 30000, 2000);
  check(!!dp && dp.image === photo && dp.ld.some((x) => x['@type'] === 'Physician' && x.image === photo), 'the photo shows on the profile, in its sharing card and in its search data');
} finally {
  const d = await call('GET', `/api/provider/v1/doctors/${asha.id}`, cAdmin);
  await call('PATCH', `/api/provider/v1/doctors/${asha.id}`, cAdmin, { photoUrl: null, version: d.version });
}

// ---- 5. bookings from a campaign link (Aarogya has analytics)
const P = await patient(A);
const doc = (await call('GET', '/api/provider/v1/public/doctors?limit=20', null, undefined, A)).items.find((d) => d.slug === 'ananya-sharma-cardiology');
const days = (await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=30`, null, undefined, A)).days ?? [];
// within Aarogya's booking window for non-members (14 days)
const open = (d) => d.slots.filter((x) => x.available !== false && !x.membersOnly);
const free = days.slice(2, 10).filter((d) => open(d).length).map((d) => open(d).at(-1)); // one a day (one visit per doctor per day), none held for members
const CAMPAIGN = `whatsapp / growth-${SFX}`;
const b1 = await call('POST', '/api/scheduling/v1/appointments', P.token, { slotId: free.at(-1)?.slotId, patientId: P.id, reason: null, paymentMode: 'AT_CLINIC', campaign: CAMPAIGN.toUpperCase() }, A);
const b2 = await call('POST', '/api/scheduling/v1/appointments', P.token, { slotId: free.at(-2)?.slotId, patientId: P.id, reason: null, paymentMode: 'AT_CLINIC', campaign: '<b>evil</b>' }, A);
check(b1.http === 201 && b2.http === 201, 'bookings made with a campaign tag (and one with a damaged tag) both go through');
const rows = psql('t_aarogya', `SELECT string_agg(coalesce(campaign, '∅'), ',' ORDER BY appointment_no) FROM scheduling.appointments WHERE id IN ('${b1.id}', '${b2.id}')`);
check(rows === `${CAMPAIGN},∅`, `the booking keeps its campaign, the damaged tag is dropped (${rows})`);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const until = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
const by = await waitFor(async () => { const r = await call('POST', '/api/analytics/v1/analytics/query', aAdmin, { metric: 'appointments', from: today, to: until, groupBy: 'campaign', limit: 50 }, A); return r.rows?.find((x) => x.key === CAMPAIGN) ? r : null; }, 30000, 2000);
check(by?.rows.find((x) => x.key === CAMPAIGN)?.value === 1, `analytics shows bookings by campaign link (${CAMPAIGN}: ${by?.rows.find((x) => x.key === CAMPAIGN)?.value})`);
const cols = psql('t_aarogya', `SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = 'fact_appointments'`);
check(cols.includes('campaign') && !/patient_id|phone|name/.test(cols.replace('patient_key', '')), 'the warehouse keeps the campaign, still without patient details');
for (const b of [b1, b2]) if (b.id) await call('POST', `/api/scheduling/v1/appointments/${b.id}/cancel`, P.token, { reason: 'growth test' }, A);
check(readFileSync(join(PLATFORM, '../frontend/apps/zone-patient/src/lib/campaign.tsx'), 'utf8').includes('mc_src') && !/googletagmanager|fbevents/.test(readFileSync(join(PLATFORM, '../frontend/apps/zone-patient/src/app/layout.tsx'), 'utf8')), 'the patient zone sets only its first-party campaign cookie, no ad tags');

// this run's demo requests are test data: remove them (and their conversions) so the console's funnel stays readable
psql('mc_control', `DELETE FROM tenant.conversions WHERE ref_id IN (SELECT id FROM tenant.leads WHERE hospital_name LIKE 'Growth Clinic ${LETTERS}%'); DELETE FROM tenant.leads WHERE hospital_name LIKE 'Growth Clinic ${LETTERS}%'`);

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mgrowth: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
