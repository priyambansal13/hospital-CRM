#!/usr/bin/env node
// Hospital-site SEO (docs/SEO-AND-ADS.md §2), against the local stack and the web zones:
//   every public page has its own title, description and canonical address and may be indexed → the sitemap lists
//   exactly the public pages (all answer, none private, no patient data) → robots.txt lets crawlers reach only those →
//   structured data is valid JSON with the right types → a doctor's readable address follows publish, rename (old
//   address and id redirect) and unpublish → one hospital's pages never answer on another's host → staff and patient
//   pages say noindex → a hospital taken offline tells crawlers to keep out.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const WEB = (host) => `http://${host}:3400`;
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
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
async function staffToken(email, slug) {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
/** A web page as a crawler gets it: no cookies, redirects not followed. */
async function page(url) {
  const get = () => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
  const r = await get().catch(() => get());
  const html = r.status === 200 ? await r.text() : '';
  const attr = (re) => re.exec(html)?.[1]?.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"') ?? null;
  return {
    status: r.status, location: r.headers.get('location'), html,
    title: attr(/<title>([^<]*)<\/title>/),
    description: attr(/<meta name="description" content="([^"]*)"/),
    robots: attr(/<meta name="robots" content="([^"]*)"/),
    canonical: attr(/<link rel="canonical" href="([^"]*)"/),
    ld: [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) => m[1]),
  };
}
const ldTypes = (p) => p.ld.flatMap((raw) => { try { return [JSON.parse(raw)].flat(); } catch { return [{ '@type': 'INVALID' }]; } });
const text = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(120_000) }); return { status: r.status, body: await r.text(), type: r.headers.get('content-type') }; };

/** Google's robots.txt rule: the longest matching path wins, Allow on a tie; `$` anchors the end. */
function robotsAllows(robots, path) {
  const rules = robots.split('\n').map((l) => /^(Allow|Disallow):\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => ({ allow: m[1] === 'Allow', path: m[2] }));
  const matches = rules.filter((r) => r.path && (r.path.endsWith('$') ? path === r.path.slice(0, -1) : path.startsWith(r.path)));
  if (!matches.length) return true;
  matches.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return matches[0].allow;
}

// ---- 1. public pages of a hospital
const pubDoctors = await call('GET', '/api/provider/v1/public/doctors?limit=50', null, undefined, A);
const doc = pubDoctors.items.find((d) => d.slug === 'ananya-sharma-cardiology') ?? pubDoctors.items[0];
const pages = {
  home: '/', doctors: '/care/doctors', doctor: `/care/doctors/${doc.slug}`, specialty: '/care/specialties/cardiology',
  branch: '/care/branches/noida-sector-62', tests: '/care/tests', test: '/care/tests/hba1c', pkg: '/care/packages/full-body',
};
const got = {};
for (const [k, p] of Object.entries(pages)) got[k] = await page(WEB(A) + p);
const all = Object.entries(got);
check(all.every(([, p]) => p.status === 200), `public pages answer: ${all.map(([k, p]) => `${k} ${p.status}`).join(', ')}`);
check(new Set(all.map(([, p]) => p.title)).size === all.length && all.every(([, p]) => p.title?.includes('Aarogya Hospitals') && !/MediCare/.test(p.title)), 'each page has its own title, with the hospital\'s name and not ours');
check(all.every(([, p]) => p.description && p.description.length >= 50 && p.description.length <= 160), 'each page has a description of search-result length');
check(all.every(([k, p]) => p.canonical === WEB(A) + pages[k]), 'each page names itself as the canonical address');
check(all.every(([, p]) => p.robots === 'index, follow'), 'public pages may be indexed');
check(/Dr\. Ananya Sharma, Cardiology/.test(got.doctor.title) && /Cardiology/.test(got.specialty.title) && /Noida, Sector 62/.test(got.branch.title) && /₹\d+/.test(got.test.title), `titles carry the data: "${got.doctor.title}"`);

// ---- 2. structured data
const types = Object.fromEntries(all.map(([k, p]) => [k, ldTypes(p)]));
check(all.every(([, p]) => p.ld.every((raw) => !raw.includes('<'))) && Object.values(types).flat().every((x) => x['@type'] !== 'INVALID'), 'structured data parses everywhere and can never close its script tag');
const org = types.home.find((x) => x['@type'] === 'MedicalOrganization');
check(org?.subOrganization?.length === 3 && org.subOrganization.every((b) => b['@type'] === 'MedicalClinic' && b.address?.addressLocality && b.address.addressCountry === 'IN'), 'home: the hospital with its 3 branches and their addresses');
const phys = types.doctor.find((x) => x['@type'] === 'Physician');
check(phys?.url === WEB(A) + pages.doctor && phys.medicalSpecialty?.includes('Cardiology') && phys.potentialAction?.['@type'] === 'ReserveAction', 'doctor: Physician with specialty and a booking action');
const svc = types.test.find((x) => x['@type'] === 'Service');
check(svc?.offers?.priceCurrency === 'INR' && Number(svc.offers.price) > 0 && types.pkg.some((x) => x['@type'] === 'Service' && x.offers), `tests and packages: offered at a price (₹${svc?.offers?.price})`);
check(['doctor', 'specialty', 'branch', 'test', 'pkg'].every((k) => types[k].some((x) => x['@type'] === 'BreadcrumbList' && x.itemListElement?.[0]?.item === `${WEB(A)}/`)), 'breadcrumbs on every inner page, starting at the hospital');
check(types.branch.some((x) => x['@type'] === 'MedicalClinic' && x.url === WEB(A) + pages.branch), 'branch page: the branch as a clinic with its own address');

// ---- 3. sitemap and robots
const sm = await text(`${WEB(A)}/sitemap.xml`);
const urls = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const allDocs = []; let cur = null;
do { const r = await call('GET', `/api/provider/v1/public/doctors?limit=50${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`, null, undefined, A); allDocs.push(...r.items); cur = r.nextCursor; } while (cur);
const robots = (await text(`${WEB(A)}/robots.txt`)).body;
check(sm.status === 200 && /xml/.test(sm.type) && Object.values(pages).every((p) => urls.includes(WEB(A) + p)), `sitemap: ${urls.length} addresses, including every page above`);
check(allDocs.every((d) => urls.includes(`${WEB(A)}/care/doctors/${d.slug}`)) && urls.filter((u) => u.includes('/care/doctors/')).length === allDocs.length, `sitemap: every published doctor (${allDocs.length}) by readable address, nobody else`);
check(urls.every((u) => u.startsWith(`${WEB(A)}/`)) && !urls.some((u) => /\/care\/(appointments|bills|timeline|lab-orders|prescriptions|profile|verify|tests\/book|assistant)|\/(desk|doctor|lab|admin|account|platform|login)(\/|$)/.test(u)), 'sitemap: only this hospital\'s public pages, nothing that needs sign-in');
check(!/\+91|\b\d{10}\b|@/.test(sm.body + robots), 'sitemap and robots carry no phone numbers or e-mail addresses');
const statuses = [];
for (let i = 0; i < urls.length; i += 6) statuses.push(...await Promise.all(urls.slice(i, i + 6).map(async (u) => ({ u, p: await page(u) }))));
const bad = statuses.filter(({ u, p }) => p.status !== 200 || p.robots !== 'index, follow' || p.canonical !== u);
check(!bad.length, `every sitemap address answers 200, may be indexed and is its own canonical${bad.length ? `: ${bad.slice(0, 3).map(({ u, p }) => `${u} ${p.status} ${p.robots} ${p.canonical}`).join('; ')}` : ''}`);
check(urls.every((u) => robotsAllows(robots, new URL(u).pathname)) && /Sitemap: http:\/\/aarogya\.localhost:3400\/sitemap\.xml/.test(robots), 'robots.txt lets crawlers reach every sitemap address and points to the sitemap');
const privatePaths = ['/care/appointments', '/care/bills', '/care/timeline', '/care/tests/book', '/care/verify/ABC123', '/care/assistant', '/login', '/desk', '/doctor', '/doctor/queue', '/lab', '/admin', '/admin/staff', '/account', '/platform', '/api/tenant/v1/public/branding', '/auth/staff', '/signup'];
check(privatePaths.every((p) => !robotsAllows(robots, p)), 'robots.txt keeps crawlers out of patients\' pages, report checks, sign-in, staff zones and the API');

// ---- 4. noindex where it must be
const login = await page(`${WEB(A)}/login`);
const filtered = await page(`${WEB(A)}/care/doctors?q=fever`);
check(login.robots === 'noindex, nofollow', 'sign-in page: noindex');
check(filtered.robots === 'noindex, follow' && filtered.canonical === `${WEB(A)}/care/doctors`, 'a filtered doctor list: noindex (its links still followed), canonical is the plain list');
const zones = ['desk', 'doctor', 'lab', 'admin', 'account', 'platform'];
const layouts = zones.map((z) => readFileSync(join(PLATFORM, `../frontend/apps/zone-${z}/src/app/layout.tsx`), 'utf8'));
check(layouts.every((l) => /robots: \{ index: false, follow: false \}/.test(l)) && /robots: \{ index: false, follow: false \}/.test(readFileSync(join(PLATFORM, '../frontend/apps/zone-patient/src/app/layout.tsx'), 'utf8')), 'every staff zone, and the patient zone by default, says noindex');
const mPricing = await page(`${WEB('medicare.localhost')}/pricing`);
const hPricing = await page(`${WEB(A)}/pricing`);
check(mPricing.robots === 'index, follow' && hPricing.robots?.startsWith('noindex'), 'MediCare\'s pricing is indexed on MediCare\'s host only');

// ---- 5. a doctor's address through publish, rename and unpublish (City Care)
const admin = await staffToken('admin@citycare.test', 'citycare');
const branch = (await call('GET', '/api/tenant/v1/branches', admin)).list.find((b) => b.active);
const name = `Dr. Seo ${LETTERS[0].toUpperCase()}${LETTERS.slice(1)}`;
const mk = (n, i) => call('POST', '/api/provider/v1/doctors', admin, { name: n, email: `seo${i}.${SFX}@citycare.test`, registrationNo: `SEO${i}/${SFX}`, specialties: [{ code: 'DERMATOLOGY', primary: true }], branches: [{ branchId: branch.id, fee: 400 }], consultModes: ['IN_PERSON'] });
const d1 = await mk(name, 1);
const d2 = await mk(name, 2);
const base = `seo-${LETTERS}-dermatology`;
check(d1.http === 201 && d1.slug === base && d2.slug === `${base}-2`, `new doctors get readable addresses; the same name twice: ${d1.slug}, ${d2.slug}`);
const publish = (d, status) => call('POST', `/api/provider/v1/doctors/${d.id}/status`, admin, { status });
await publish(d1, 'ACTIVE');
const inMap = async (path, want) => waitFor(async () => (await text(`${WEB(C)}/sitemap.xml`)).body.includes(`${WEB(C)}${path}<`) === want, 60000, 2000);
check(await inMap(`/care/doctors/${base}`, true) && !(await text(`${WEB(C)}/sitemap.xml`)).body.includes(`/care/doctors/${base}-2<`), 'published: in the sitemap; still a draft: not');
const p1 = await page(`${WEB(C)}/care/doctors/${base}`);
check(p1.status === 200 && p1.canonical === `${WEB(C)}/care/doctors/${base}`, 'its page answers at the readable address');
const byId = await page(`${WEB(C)}/care/doctors/${d1.id}?date=2026-12-01`);
check([301, 308].includes(byId.status) && byId.location === `${WEB(C)}/care/doctors/${base}?date=2026-12-01`, `an old id link redirects for good (${byId.status}), keeping the query`);
const cur1 = await call('GET', `/api/provider/v1/doctors/${d1.id}`, admin);
const renamed = await call('PATCH', `/api/provider/v1/doctors/${d1.id}`, admin, { name: `${name} Rao`, version: cur1.version });
const newSlug = `seo-${LETTERS}-rao-dermatology`;
check(renamed.slug === newSlug, `renamed: new address ${renamed.slug}`);
const old = await page(`${WEB(C)}/care/doctors/${base}`);
check([301, 308].includes(old.status) && old.location === `${WEB(C)}/care/doctors/${newSlug}`, 'the old address redirects for good to the new one');
check(await inMap(`/care/doctors/${newSlug}`, true) && await inMap(`/care/doctors/${base}`, false), 'the sitemap has the new address only');
const d3 = await mk(name, 3);
check(d3.slug === `${base}-3`, `a retired address is not given to someone else (${d3.slug})`);
await publish(d1, 'INACTIVE');
check(await inMap(`/care/doctors/${newSlug}`, false) && (await page(`${WEB(C)}/care/doctors/${newSlug}`)).status === 404 && (await page(`${WEB(C)}/care/doctors/${base}`)).status === 404, 'unpublished: out of the sitemap, and both addresses are not found');
check(!(await text(`${WEB(C)}/sitemap.xml`)).body.includes(A), 'City Care\'s sitemap never lists Aarogya');

// ---- 6. hospitals don't leak into each other
const cross = await page(`${WEB(C)}/care/doctors/${doc.slug}`);
const crossId = await page(`${WEB(C)}/care/doctors/${doc.id}`);
const crossBranch = await page(`${WEB(C)}/care/branches/noida-sector-62`);
const cityHasNoida = (await call('GET', '/api/tenant/v1/public/branches', null, undefined, C)).list.some((b) => b.slug === 'noida-sector-62');
check(cross.status === 404 && crossId.status === 404 && (cityHasNoida || crossBranch.status === 404), 'an Aarogya doctor (by address or id) and branch are not found on City Care\'s host');

// ---- 7. a hospital taken offline
const tmp = `seo${SFX}`;
execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), 'tenant', 'create', tmp, '--name', `Seo ${LETTERS}`, '--plan', 'CLINIC_STARTER'], { stdio: 'ignore' });
const support = await staffToken('support@medicare.test', 'medicare');
const tid = (await (await fetch('http://localhost:4401/internal/tenants', { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } })).json()).find((t) => t.slug === tmp).id;
const S = (b) => call('POST', `/api/subscription/v1/platform/hospitals/${tid}/status`, support, b, 'medicare.localhost');
const openRobots = await waitFor(async () => { const r = await text(`${WEB(`${tmp}.localhost`)}/robots.txt`); return r.body.includes('Allow: /care/doctors') && r.body; }, 60000, 2000);
check(!!openRobots, 'a new hospital is crawlable as soon as it is open');
await S({ status: 'SUSPENDED', reason: 'seo test: offline' });
const offRobots = await waitFor(async () => { const r = await text(`${WEB(`${tmp}.localhost`)}/robots.txt`); return r.body.trim() === 'User-agent: *\nDisallow: /' && r; }, 60000, 2000);
const offMap = await text(`${WEB(`${tmp}.localhost`)}/sitemap.xml`);
check(offRobots?.status === 200 && offMap.status === 404, 'taken offline: robots.txt says keep out of everything, no sitemap');
await S({ status: 'DELETED', reason: 'seo test hospital, not needed', confirmSlug: tmp });

// leave City Care as it was: the test doctors unpublished
await Promise.all([d2, d3].map((d) => d.id && publish(d, 'INACTIVE')));

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mseo: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
