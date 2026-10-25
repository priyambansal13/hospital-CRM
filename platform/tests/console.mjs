#!/usr/bin/env node
// Platform console and plan builder (Phase 18), against the local gateway, as MediCare's own staff (hospital "medicare"):
//   access (only MediCare HQ, per role) → a product manager builds "Diagnostic Center – Professional" from nothing
//   (validation, internal modules refused) → submits → the two-person rule → an approver sees the impact and publishes →
//   support simulates and moves greenleaf to it → the next version is published with "move everyone now" → limit
//   override → internal plans/modules can't be given to a hospital → audit → clean-up (greenleaf back, plan retired).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const HQ = 'medicare.localhost';
const C = '/api/subscription/v1/platform';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mc = (...args) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...args], { encoding: 'utf8' });
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
async function call(method, path, token, body, host = HQ) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': host, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), status: r.status, _body: j };
}
async function staffToken(email, slug = 'medicare') {
  const j = await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const waitFor = async (fn, ms = 30000, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return undefined; };

// ---- setup: MediCare HQ and its staff; greenleaf (from `mc test plans`) on Clinic Starter
const tenants = JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' }));
if (!tenants.some((t) => t.slug === 'medicare')) { mc('seed', 'demo'); await sleep(5000); }
if (!tenants.some((t) => t.slug === 'greenleaf')) mc('tenant', 'create', 'greenleaf', '--name', 'Greenleaf Clinic', '--admin', 'admin@greenleaf.test', '--plan', 'CLINIC_STARTER');
const admin = await waitFor(() => staffToken('admin@medicare.test').catch(() => null), 60000, 2000);
for (const [email, name, roles] of [['product@medicare.test', 'Priya Product', ['PLATFORM_PRODUCT']], ['approver@medicare.test', 'Arjun Approver', ['PLATFORM_APPROVER']], ['support@medicare.test', 'Sana Support', ['PLATFORM_SUPPORT']]]) {
  await call('POST', '/api/iam/v1/staff/invites', admin, { email, name, roles });
}
await sleep(1500);
const [pm, ap, sup] = await Promise.all(['product', 'approver', 'support'].map((u) => waitFor(() => staffToken(`${u}@medicare.test`).catch(() => null), 30000, 1000)));
await waitFor(async () => (await call('GET', `${C}/plans`, pm)).status === 200, 60000, 1000); // the platform module may still be switching on
const greenleaf = (await call('GET', `${C}/hospitals`, sup)).list.find((h) => h.slug === 'greenleaf');
if (greenleaf.plan?.code !== 'CLINIC_STARTER') mc('plan', 'set', 'greenleaf', 'CLINIC_STARTER', '--reason', 'mc test console setup');

// ---- 1. access
const city = await staffToken('admin@citycare.test', 'citycare');
const fromCity = await call('GET', `${C}/hospitals`, city, undefined, 'citycare.localhost');
check([403, 404].includes(fromCity.status), `a hospital admin cannot open the console (${fromCity.status} ${fromCity.code})`);
const caps = await call('GET', '/api/entitlement/v1/me/capabilities', pm);
check(caps.modules.includes('platform') && caps.nav.some((n) => n.zone === 'platform') && caps.home === '/platform/plans', `product manager: console in the menu, home ${caps.home}`);
check((await call('GET', '/api/entitlement/v1/me/capabilities', city, undefined, 'citycare.localhost')).nav.every((n) => n.zone !== 'platform'), 'hospitals never see the console in their menu');
check((await call('POST', `${C}/plans`, sup, { code: 'NOPE_PLAN', name: 'Nope', edition: 'CLINIC', tier: 'Starter' })).code === 'PERMISSION_DENIED', 'support cannot build plans');
const pub = await call('GET', '/api/subscription/v1/plans', null, undefined, 'citycare.localhost');
check(!pub.list.some((p) => p.code === 'MEDICARE_HQ'), 'the internal MediCare HQ plan is never listed');
const reg = await call('GET', `${C}/registry`, pm);
check(reg.list?.some((m) => m.key === 'platform' && m.internal) && reg.list.some((m) => m.key === 'diagnostics' && m.lifecycle.includes('diagnostics')), `module registry: ${reg.list?.length} modules from the manifests`);

// ---- 2. a product manager builds "Diagnostic Center – Professional"
const CODE = `DIAG_CENTER_PRO_${String(Date.now()).slice(-6)}`;
const created = await call('POST', `${C}/plans`, pm, { code: CODE, name: 'Diagnostic Center – Professional', edition: 'DIAGNOSTIC_CENTER', tier: 'Professional', description: 'Labs with home collection' });
check(created.status === 201 || created.status === 200, `plan ${CODE} created with draft v1`);
const v1 = created.versionId;
check((await call('POST', `${C}/plans`, pm, { code: CODE, name: 'Duplicate', edition: 'CLINIC', tier: 'Starter' })).code === 'PLAN_EXISTS', 'plan codes are unique');
const bad = await call('PUT', `${C}/versions/${v1}`, pm, { listPrice: 14999, modules: ['core', 'home_collection', 'platform'], features: { 'core.custom_roles': { enabled: true, limit: 3 } } });
check(bad.status === 200 && bad.problems.some((p) => /Home sample collection needs Diagnostics and lab/.test(p)) && bad.problems.some((p) => /platform is internal/.test(p)), `draft saved with problems: ${bad.problems?.join(' | ')}`);
check((await call('POST', `${C}/versions/${v1}/submit`, pm)).code === 'PLAN_INVALID', 'a draft with problems cannot be submitted');
const def = {
  listPrice: 14999, trialDays: 14,
  modules: ['core', 'diagnostics', 'home_collection', 'billing'],
  features: { 'core.branches': { enabled: true, limit: 3 }, 'core.custom_roles': { enabled: true, limit: null }, 'diagnostics.packages': { enabled: true, limit: null } },
  settings: { 'diagnostics.max_advance_days': { min: 1, max: 45 } },
  addons: ['BRANCHES_5'],
};
const good = await call('PUT', `${C}/versions/${v1}`, pm, def);
check(good.status === 200 && good.problems.length === 0, 'fixed: core, diagnostics, home collection, billing; 3 branches; ₹14,999');
const sub = await call('POST', `${C}/versions/${v1}/submit`, pm);
check(sub.status < 300, 'submitted for approval');
const pending = await call('GET', `${C}/versions/${v1}`, pm);
check(pending._body.status === 'PENDING' && pending.submittedBy === 'product@medicare.test', `status ${pending._body.status}, submitted by ${pending.submittedBy}`);
check((await call('PUT', `${C}/versions/${v1}`, pm, def)).code === 'NOT_A_DRAFT', 'a version waiting for approval cannot be edited');
check((await call('POST', `${C}/versions/${v1}/approve`, pm, {})).code === 'PERMISSION_DENIED', 'the product manager cannot approve');

// two-person rule: the hospital admin of HQ has every permission, but cannot approve what they submitted
const own = await call('POST', `${C}/plans`, admin, { code: `${CODE}_X`, name: 'Self-approved', edition: 'CLINIC', tier: 'Test', copyFrom: 'CLINIC_STARTER' });
await call('POST', `${C}/versions/${own.versionId}/submit`, admin);
const self = await call('POST', `${C}/versions/${own.versionId}/approve`, admin, {});
check(self.status === 403 && self.code === 'TWO_PERSON_RULE', 'two-person rule: whoever built/submitted a version cannot publish it');
const back = await call('POST', `${C}/versions/${own.versionId}/reject`, ap, { note: 'not needed' });
check(back._body.status === 'DRAFT' && back.reviewNote === 'not needed', 'approver sends it back to draft with a note');
check((await call('DELETE', `${C}/versions/${own.versionId}`, admin)).planRemoved === true, 'the draft is discarded (and its never-published plan with it)');

// ---- 3. the approver: impact preview, publish
const imp = await call('GET', `${C}/versions/${v1}/impact`, ap);
check(imp.status === 200 && imp.versusPublished === null && imp.hospitals.length === 0, 'impact: a new plan, no hospital affected');
const ok1 = await call('POST', `${C}/versions/${v1}/approve`, ap, { migration: 'NEW_ONLY', note: 'looks good' });
check(ok1._body.status === 'PUBLISHED' && ok1.approvedBy === 'approver@medicare.test', 'approver publishes v1');
const listed = await call('GET', '/api/subscription/v1/plans', null, undefined, 'citycare.localhost');
check(listed.list.some((p) => p.code === CODE && p.listPrice === 14999), 'it is in the published plan list at once');

// ---- 4. support: simulate, then move greenleaf
const sim = await call('POST', `${C}/hospitals/${greenleaf.id}/simulate`, sup, { versionId: v1, addons: [] });
check(sim.status < 300 && sim.diff.modulesAdded.includes('diagnostics') && sim.diff.modulesRemoved.includes('appointments') && sim.price === 14999 && sim.currentPrice === 4999, `simulator: greenleaf would gain ${sim.diff?.modulesAdded.join(', ')}, lose ${sim.diff?.modulesRemoved.join(', ')}; ₹${sim.currentPrice} → ₹${sim.price}`);
check((await call('PUT', `${C}/hospitals/${greenleaf.id}/contract`, pm, { plan: CODE, addons: [], reason: 'x' })).code === 'PERMISSION_DENIED', 'a product manager cannot move hospitals');
const moved = await call('PUT', `${C}/hospitals/${greenleaf.id}/contract`, sup, { plan: CODE, addons: [{ code: 'BRANCHES_5' }], reason: 'Greenleaf now runs a lab (order form #77)' });
check(moved.status === 200 && moved.plan.code === CODE && moved.addons[0]?.code === 'BRANCHES_5', `greenleaf → ${moved.plan?.name} + 5 more branches`);
const gAdmin = await staffToken('admin@greenleaf.test', 'greenleaf');
const gcaps = await waitFor(async () => { const c = await call('GET', '/api/entitlement/v1/me/capabilities', gAdmin, undefined, 'greenleaf.localhost'); return c.modules?.includes('home_collection') ? c : null; }, 30000, 1000);
check(!!gcaps && gcaps.readOnlyModules.includes('appointments') && gcaps.features['core.branches'].limit === 8, `greenleaf: lab + home collection on, appointments read-only, branches ${gcaps?.features['core.branches'].limit}`);
check((await call('PUT', `${C}/hospitals/${greenleaf.id}/contract`, sup, { plan: 'MEDICARE_HQ', reason: 'try' })).code === 'PLAN_INTERNAL', "MediCare HQ's plan cannot be given to a hospital");
check((await call('PUT', `${C}/hospitals/${greenleaf.id}/modules/platform`, sup, { state: 'on', reason: 'try' })).code === 'MODULE_INTERNAL', 'the console module cannot be switched on for a hospital');

// ---- 5. the next version, everyone moved at once
const nv = await call('POST', `${C}/plans/${CODE}/versions`, pm);
check(nv.version === 2, 'product manager starts v2 from v1');
check((await call('POST', `${C}/plans/${CODE}/versions`, pm)).code === 'DRAFT_EXISTS', 'one open draft per plan');
await call('PUT', `${C}/versions/${nv.versionId}`, pm, { ...def, listPrice: 15999, features: { ...def.features, 'core.branches': { enabled: true, limit: 5 } } });
await call('POST', `${C}/versions/${nv.versionId}/submit`, pm);
const imp2 = await call('GET', `${C}/versions/${nv.versionId}/impact`, ap);
const gl = imp2.hospitals?.find((h) => h.slug === 'greenleaf');
check(imp2.versusPublished?.version === 1 && imp2.versusPublished.features.some((f) => f.key === 'core.branches' && f.before.limit === 3 && f.after.limit === 5) && gl?.fromVersion === 1 && gl.price.before === 14999 + 2999 && gl.price.after === 15999 + 2999,
  `impact of v2: branches 3 → 5, ₹14,999 → ₹15,999; greenleaf on v1 (₹${gl?.price.before} → ₹${gl?.price.after} with its add-on)`);
const ok2 = await call('POST', `${C}/versions/${nv.versionId}/approve`, ap, { migration: 'MIGRATE_NOW' });
check(ok2._body.status === 'PUBLISHED' && ok2.moved.includes('greenleaf') && ok2.failed.length === 0, `v2 published, moved now: ${ok2.moved?.join(', ')}`);
const plans = (await call('GET', `${C}/plans`, ap)).list.find((p) => p.code === CODE);
check(plans.versions.find((v) => v.version === 1).status === 'RETIRED' && plans.versions.find((v) => v.version === 2).hospitals === 1, 'v1 retired (no longer sold), greenleaf on v2');
const g2 = await waitFor(async () => { const c = await call('GET', '/api/entitlement/v1/me/capabilities', gAdmin, undefined, 'greenleaf.localhost'); return c.features?.['core.branches'].limit === 10 ? c : null; }, 30000, 1000);
check(!!g2, 'greenleaf: branches 5 + 5 (add-on kept) = 10');

// ---- 6. a limit override for one hospital
const ov = await call('PUT', `${C}/hospitals/${greenleaf.id}/features/core.branches`, sup, { value: { limit: 40 }, reason: 'Enterprise deal, 40 branches' });
check(ov.effective?.features['core.branches'].limit === 40, 'support: greenleaf gets 40 branches (override, with a reason)');
const reset = await call('PUT', `${C}/hospitals/${greenleaf.id}/features/core.branches`, sup, { value: null, reason: 'deal ended' });
check(reset.effective?.features['core.branches'].limit === 10, 'override removed: back to 10');

// ---- 7. audit
const audit = (await call('GET', `${C}/audit?limit=200`, sup)).list ?? [];
const has = (action, actor, label) => audit.some((a) => a.action === action && a.actor === actor && (!label || (a.target.label ?? '').includes(label)));
check(has('PLAN_CREATED', 'product@medicare.test', '') && has('VERSION_SUBMITTED', 'product@medicare.test', CODE) && has('VERSION_PUBLISHED', 'approver@medicare.test', CODE)
  && has('CONTRACT_CHANGED', 'support@medicare.test', 'greenleaf') && has('FEATURE_OVERRIDE', 'support@medicare.test', 'greenleaf') && has('VERSION_DISCARDED', 'admin@medicare.test', ''),
  'audit: created, submitted, published, contract change, override, discard: each with who did it');
const contractChange = audit.find((a) => a.action === 'CONTRACT_CHANGED' && a.actor === 'support@medicare.test');
check(/^CLINIC_STARTER v\d+$/.test(contractChange?.before?.plan ?? '') && contractChange.after.plan === `${CODE} v1`, `audit keeps before/after (${contractChange?.before?.plan} → ${contractChange?.after?.plan})`);
const detail = await call('GET', `${C}/hospitals/${greenleaf.id}`, sup);
check(detail.status === 200 && detail.contract.plan.code === CODE && detail.moduleStates?.length > 0 && detail.history.length > 1, 'hospital page data: contract, module states, history');

// ---- clean-up: greenleaf back on Clinic Starter, the test plan retired
await call('PUT', `${C}/hospitals/${greenleaf.id}/contract`, sup, { plan: 'CLINIC_STARTER', addons: [], reason: 'mc test console clean-up' });
check((await call('POST', `${C}/versions/${nv.versionId}/retire`, ap)).status < 300, 'clean-up: greenleaf back on Clinic Starter, test plan retired');

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mconsole ok\x1b[0m');
process.exit(failures ? 1 : 0);
