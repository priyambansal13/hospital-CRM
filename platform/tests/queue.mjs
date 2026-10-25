#!/usr/bin/env node
// Front desk + live queue test (Phase 10), against the local gateway:
//   receptionist registers a walk-in → books + checks in → the doctor's live stream gets the signal within seconds;
//   20 concurrent check-ins get 20 distinct, gap-free tokens; one visit at a time per doctor; start → complete;
//   the no-show sweep marks a missed appointment; other hospitals / patients cannot watch or touch the queue.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(PLATFORM, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const benv = Object.fromEntries(readFileSync(join(PLATFORM, '../backend/.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };

async function call(method, path, token, body, host = 'citycare.localhost', extra = {}) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': host, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ...j, status: r.status, _body: j }; // status = HTTP status; the body's own status is in _body
}
async function staffToken(email, slug = 'citycare') {
  const r = await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${slug}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
/** Open an SSE stream; returns { events, status, close }. */
async function stream(path, token, host = 'citycare.localhost') {
  const ac = new AbortController();
  const res = await fetch(G + path, { headers: { 'x-tenant-host': host, authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ac.signal });
  const events = [];
  if (res.ok) {
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (ev) events.push({ ev, data: data ? JSON.parse(data) : null, at: Date.now() });
          }
        }
      } catch { /* aborted */ }
    })();
  } else await res.text();
  return { status: res.status, events, close: () => ac.abort() };
}
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); } return undefined; };
const phone = () => `+9193${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 90) + 10)}`;

// ---- setup: a receptionist, the demo doctor, the branch
const admin = await staffToken('admin@citycare.test');
const inv = await call('POST', '/api/iam/v1/staff/invites', admin, { email: 'desk@citycare.test', name: 'Riya Desk', roles: ['RECEPTIONIST'] }, undefined, { 'idempotency-key': crypto.randomUUID() });
check([200, 201].includes(inv.status), `receptionist desk@citycare.test ready (${inv.status})`);
await sleep(1500);
const desk = await staffToken('desk@citycare.test');
const doctorTok = await staffToken('asha.rao@citycare.test');
const me = await call('GET', '/api/scheduling/v1/me/doctor', doctorTok);
const branches = (await call('GET', '/api/tenant/v1/branches', desk))._body.filter((b) => b.active);
const branch = branches.find((b) => true);
let board = await call('GET', `/api/scheduling/v1/desk/board?branchId=${branch.id}`, desk);
const branchOfAsha = board.doctors?.some((d) => d.id === me.id) ? branch : undefined;
let br = branchOfAsha;
for (const b of branches) { if (br) break; board = await call('GET', `/api/scheduling/v1/desk/board?branchId=${b.id}`, desk); if (board.doctors.some((d) => d.id === me.id)) br = b; }
check(!!br, `desk board lists ${me.name} at ${br?.name}`);

// ---- access rules
const sunAdmin = await staffToken('admin@sunrise.test', 'sunrise');
check((await call('GET', `/api/scheduling/v1/doctors/${me.id}/queue`, sunAdmin, undefined, 'sunrise.localhost')).status === 404, 'another hospital cannot read this doctor\'s queue (404)');
check((await call('GET', `/api/scheduling/v1/desk/board?branchId=${br.id}`, doctorTok)).status === 403, 'a doctor cannot open the desk board (403)');
check((await call('POST', '/api/patient/v1/desk/patients', doctorTok, { phone: phone(), fullName: 'X Y', dob: '1990-01-01' })).status === 403, 'a doctor cannot register patients at the desk (403)');
const foreign = await stream(`/api/realtime/v1/realtime/queue?doctorId=${me.id}`, sunAdmin, 'sunrise.localhost');
check(foreign.status === 404, `another hospital cannot watch the queue live (${foreign.status})`);
const noTok = await call('GET', `/api/realtime/v1/realtime/queue?doctorId=${me.id}`, null);
check(noTok.status === 401, 'live stream needs a token (401)');

// ---- registration
const ph = phone();
const mum = await call('POST', '/api/patient/v1/desk/patients', desk, { phone: ph.replace('+91', ''), fullName: 'Kavya Walkin', dob: '1991-04-02', gender: 'FEMALE' });
check(mum.status === 201 && mum.mrn?.startsWith('MRN') && mum.phone === ph, `walk-in registered by phone: ${mum.fullName} ${mum.mrn}`);
const again = await call('POST', '/api/patient/v1/desk/patients', desk, { phone: ph, fullName: 'Someone Else', dob: '1980-01-01' });
check(again.status === 409 && again.code === 'PHONE_ALREADY_REGISTERED', 'same phone as a second owner → 409 PHONE_ALREADY_REGISTERED');
const kid = await call('POST', '/api/patient/v1/desk/patients', desk, { phone: ph, fullName: 'Aarav Walkin', dob: '2019-06-10', relation: 'CHILD' });
check(kid.status === 201 && !kid.isSelf, `child added to the same phone (${kid.mrn})`);
const found = await call('GET', `/api/patient/v1/desk/patients?q=${encodeURIComponent(ph.slice(3))}`, desk);
check(found._body.length === 2 && found._body[1].guardianName === 'Kavya Walkin', 'search by mobile finds the family (owner first)');
check((await call('GET', `/api/patient/v1/desk/patients?q=${mum.mrn}`, desk))._body[0]?.id === mum.id, 'search by MRN');

// ---- live: doctor watches, desk books + checks in
const live = await stream(`/api/realtime/v1/realtime/queue?doctorId=${me.id}`, doctorTok);
check(live.status === 200 && !!(await waitFor(() => live.events.find((e) => e.ev === 'ready'))), 'doctor connected to the live queue');
const boardLive = await stream(`/api/realtime/v1/realtime/queue?branchId=${br.id}`, desk);
const t0 = Date.now();
const a1 = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: mum.id, walkIn: { doctorId: me.id, branchId: br.id }, reason: 'fever' }, undefined, { 'idempotency-key': crypto.randomUUID() });
check(a1.status === 201 && a1._body.status === 'CHECKED_IN' && a1.tokenNo > 0 && a1.source === 'WALK_IN', `walk-in booked + checked in: ${a1.appointmentNo}, token ${a1.tokenNo}`);
const sig = await waitFor(() => live.events.find((e) => e.ev === 'queue' && e.data.appointmentId === a1.id && e.data.status === 'CHECKED_IN'), 8000);
check(!!sig, `doctor's screen got the check-in signal in ${sig ? sig.at - t0 : '>8000'} ms (token ${sig?.data.tokenNo})`);
check(!JSON.stringify(live.events).includes('Kavya'), 'live signals carry no patient names');
check(!!(await waitFor(() => boardLive.events.find((e) => e.ev === 'queue' && e.data.appointmentId === a1.id))), 'desk board stream got it too');
const q = await call('GET', `/api/scheduling/v1/doctors/${me.id}/queue`, doctorTok);
check(q.appointments?.some((a) => a.id === a1.id && a.tokenNo === a1.tokenNo), 'doctor\'s queue lists the patient with their token');

// ---- 20 concurrent check-ins → distinct, consecutive tokens
const people = [];
for (let i = 0; i < 20; i++) people.push(await call('POST', '/api/patient/v1/desk/patients', desk, { phone: phone(), fullName: `Queue Person ${i}`, dob: '1985-01-01' }));
const booked = await Promise.all(people.map((p) => call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: p.id, walkIn: { doctorId: me.id, branchId: br.id }, checkIn: false }, undefined, { 'idempotency-key': crypto.randomUUID() })));
check(booked.every((b) => b._body.status === 'CONFIRMED'), '20 walk-ins booked without check-in');
const ins = await Promise.all(booked.map((b) => call('POST', `/api/scheduling/v1/desk/appointments/${b.id}/check-in`, desk)));
const tokens = ins.map((x) => x.tokenNo).sort((x, y) => x - y);
check(ins.every((x) => x.status === 200) && new Set(tokens).size === 20 && tokens[19] - tokens[0] === 19 && tokens[0] === a1.tokenNo + 1, `20 concurrent check-ins → tokens ${tokens[0]}…${tokens[19]}, no duplicates or gaps`);
check((await call('POST', `/api/scheduling/v1/desk/appointments/${booked[0].id}/check-in`, desk)).code === 'ALREADY_CHECKED_IN', 'second check-in → 409 ALREADY_CHECKED_IN');

// ---- visit lifecycle
const kidAppt = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: kid.id, walkIn: { doctorId: me.id, branchId: br.id }, checkIn: false }, undefined, { 'idempotency-key': crypto.randomUUID() });
check((await call('POST', `/api/scheduling/v1/appointments/${kidAppt.id}/start`, doctorTok)).code === 'INVALID_STATE_TRANSITION', 'cannot start a visit before check-in');
const s1 = await call('POST', `/api/scheduling/v1/appointments/${a1.id}/start`, doctorTok);
check(s1.status === 200 && s1._body.status === 'IN_PROGRESS', 'doctor calls in token ' + a1.tokenNo);
check((await call('POST', `/api/scheduling/v1/appointments/${booked[0].id}/start`, doctorTok)).code === 'DOCTOR_BUSY', 'a second visit while one is in progress → 409 DOCTOR_BUSY');
const c1 = await call('POST', `/api/scheduling/v1/appointments/${a1.id}/complete`, doctorTok);
check(c1._body.status === 'COMPLETED' && !!c1.completedAt, 'doctor completes the visit');
check(!!(await waitFor(() => boardLive.events.find((e) => e.ev === 'queue' && e.data.appointmentId === a1.id && e.data.status === 'COMPLETED'))), 'desk board saw the completion live');
const otherDoc = await call('POST', `/api/scheduling/v1/appointments/${booked[1].id}/start`, sunAdmin, undefined, 'sunrise.localhost');
check(otherDoc.status === 404, 'another hospital cannot start a visit (404)');

// ---- no-show sweep
psql(`UPDATE scheduling.appointments SET starts_at = starts_at - interval '3 hours', ends_at = ends_at - interval '3 hours' WHERE id = '${kidAppt.id}'`);
const tid = execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 'mc_control', '-c', "SELECT id FROM tenant.tenants WHERE slug = 'citycare'"], { encoding: 'utf8' }).trim();
const sw = await (await fetch(`http://localhost:4405/internal/tenants/${tid}/queue/no-show-sweep`, { method: 'POST', headers: { 'x-internal-token': benv.INTERNAL_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ graceMinutes: 60 }) })).json();
check(sw.marked >= 1 && psql(`SELECT status FROM scheduling.appointments WHERE id = '${kidAppt.id}'`) === 'NO_SHOW', `no-show sweep marked the missed appointment (${sw.marked} marked)`);
check((await fetch(`${G}/api/scheduling/internal/tenants/${tid}/queue/no-show-sweep`, { method: 'POST' })).status === 404, 'the sweep is not reachable through the gateway');

// ---- tidy up today's board: the 20 test patients "left"
await Promise.all(booked.map((b) => call('POST', `/api/scheduling/v1/appointments/${b.id}/no-show`, desk)));
live.close(); boardLive.close(); foreign.close();
console.log(failures ? `\x1b[31m${failures} failure(s)\x1b[0m` : '\x1b[32mqueue ok\x1b[0m');
process.exit(failures ? 1 : 0);
