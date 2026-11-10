#!/usr/bin/env node
// Operations (Phase 30 part 2), against the local stack:
//   the public status API lists every component with a state, from the services' health checks → MediCare support
//   posts an incident, it shows publicly (and on the public page) with its updates, and resolving it moves it to the
//   past → only support may post; a hospital's admin gets 404 → the static copy of the page is written and says the
//   right thing, also when MediCare can't be reached → the metrics the alerts use are exported.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishStatus, renderStatus } from '../scripts/status-page.mjs';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const M = 'medicare.localhost';
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };
const SFX = Date.now().toString().slice(-6);

async function call(method, path, token, body, host = M) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': host, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
const staff = async (email, slug) => (await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) })).json()).access_token;

// ---- 1. the public status
const s0 = await call('GET', '/api/tenant/v1/status');
check(s0.http === 200 && s0.components?.length === 10 && s0.components.every((c) => ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'].includes(c.state)), `public status: ${s0.components?.length} components, overall ${s0.overall}`);
check(s0.overall === 'operational', 'everything is up locally, so everything says working normally');
check(!JSON.stringify(s0).match(/citycare|aarogya|@|\+91/), 'no hospital, patient or contact details on the public status');

// ---- 2. an incident, posted and resolved by support
const support = await staff('support@medicare.test', 'medicare');
const product = await staff('product@medicare.test', 'medicare');
const admin = await staff('admin@citycare.test', 'citycare');
const title = `Online payment is failing ${SFX}`;
const inc = await call('POST', '/api/tenant/v1/platform/status/incidents', support, { title, impact: 'MAJOR', components: ['payments'], message: 'Choose pay at the hospital; your booking is kept.' });
check(inc.http === 201 && !!inc.id, 'support posts an incident');
const s1 = await call('GET', '/api/tenant/v1/status');
const shown = s1.incidents?.find((i) => i.id === inc.id);
check(shown?.status === 'INVESTIGATING' && s1.components.find((c) => c.key === 'payments')?.state === 'partial_outage' && s1.overall === 'partial_outage', `the public status shows it, and payments as ${s1.components?.find((c) => c.key === 'payments')?.state}`);
const page = await (await fetch(`http://${M}:3400/status`)).text();
check(page.includes(title) && page.includes('Choose pay at the hospital'), 'the public page shows the incident and its message');
const up = await call('POST', `/api/tenant/v1/platform/status/incidents/${inc.id}/updates`, support, { status: 'MONITORING', message: 'The provider has fixed it; watching.' });
const done = await call('POST', `/api/tenant/v1/platform/status/incidents/${inc.id}/updates`, support, { status: 'RESOLVED', message: 'Online payment works again.' });
const s2 = await call('GET', '/api/tenant/v1/status');
const past = s2.incidents?.find((i) => i.id === inc.id);
check(up.http === 201 && done.http === 201 && past?.status === 'RESOLVED' && past.updates.length === 3 && s2.components.find((c) => c.key === 'payments')?.state === 'operational', 'updates and resolving: it moves to the past 14 days, payments back to working');

// ---- 3. who may post
check((await call('POST', '/api/tenant/v1/platform/status/incidents', product, { title: 'x x x', impact: 'MINOR', components: ['search'], message: 'nope' })).http === 403, 'the product team can read incidents but not post them');
check([403, 404].includes((await call('GET', '/api/tenant/v1/platform/status/incidents', admin, undefined, 'citycare.localhost')).http), "a hospital's admin can't reach the console's incidents");
check((await call('POST', '/api/tenant/v1/platform/status/incidents', support, { title: 'Bad', impact: 'MINOR', components: ['nope'], message: 'x' })).http === 400, 'an unknown component is refused');
check((await call('POST', '/api/tenant/v1/platform/status/incidents', support, { title: 'Bad schedule', impact: 'MINOR', status: 'SCHEDULED', components: ['search'], message: 'only maintenance is planned' })).http === 400, 'only planned maintenance can be scheduled');

// ---- 4. the static copy
const dir = mkdtempSync(join(tmpdir(), 'mc-status-'));
const state = await publishStatus(dir, 'http://localhost:4401');
const html = readFileSync(join(dir, 'index.html'), 'utf8');
check(state === 'operational' && html.includes('All systems working') && JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')).components.length === 10, 'the static copy is written from the live status');
const down = renderStatus(null);
check(down.includes('MediCare cannot be reached from here') && !down.includes('All systems working'), 'when MediCare can not be reached, the copy says so instead of staying green');
check(!renderStatus({ ...s0, incidents: [{ ...shown, title: '<script>alert(1)</script>', updates: [] }] }).includes('<script>alert'), 'the copy escapes what support typed');

// ---- 5. the metrics the alerts use
const metric = async (port, name) => (await (await fetch(`http://localhost:${port + 5000}/metrics`)).text()).includes(name);
await fetch('http://localhost:4405/health/ready');
check(await metric(4401, 'mc_backup_age_seconds{tenant="citycare"') && await metric(4405, 'mc_dependency_up{dependency="redis"} 1') && await metric(4405, 'le="0.3"'), 'backup age per hospital, dependency health and the 300 ms latency bucket are exported');
check(await metric(4407, 'mc_notifications_total') || await metric(4407, '# HELP mc_notifications_total'), 'notification outcomes are exported');

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mstatus: all checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
