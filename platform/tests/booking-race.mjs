#!/usr/bin/env node
// Double-booking race test (docs/IMPLEMENTATION-PLAN.md Phase 8): 100 different patients book the SAME slot at the
// same moment through the gateway. Exactly one must win; the other 99 must get 409 SLOT_UNAVAILABLE; the database
// must hold exactly one live appointment for the slot. The winner is cancelled afterwards (no leftovers).
const G = process.env.GATEWAY_URL ?? 'http://localhost:61000';
const HOST = 'citycare.localhost';
const N = Number(process.env.RACE_N ?? 100);

async function call(method, path, token, body, extra = {}) {
  const headers = { 'x-tenant-host': HOST, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
  const r = await fetch(G + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, json: j };
}

async function patientAccount(i) {
  const phone = `+9196${String(Date.now()).slice(-6)}${String(i).padStart(2, '0')}`;
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  let code;
  for (let k = 0; k < 30 && !code; k++) {
    await new Promise((r) => setTimeout(r, 200));
    const m = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.slice(1)}@sms.medicare.local`)}`)).json();
    code = m.messages?.[0]?.Snippet?.match(/\d{6}/)?.[0];
  }
  const token = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).json.accessToken;
  const ids = [(await call('PUT', '/api/patient/v1/me/profile', token, { fullName: `Race Patient ${i}`, dob: '1990-01-01' })).json.id];
  for (let d = 1; d <= 4; d++) ids.push((await call('POST', '/api/patient/v1/me/dependents', token, { fullName: `Race Child ${i}-${d}`, dob: `2015-01-0${d}`, relation: 'CHILD' })).json.id);
  return { token, ids };
}

const main = async () => {
  console.log(`creating ${N} patients (20 accounts × 5)…`);
  const accounts = await Promise.all(Array.from({ length: Math.ceil(N / 5) }, (_, i) => patientAccount(i)));
  const contenders = accounts.flatMap((a) => a.ids.map((id) => ({ token: a.token, patientId: id }))).slice(0, N);
  if (contenders.some((c) => !c.patientId)) throw new Error('patient setup failed');

  const doctor = (await call('GET', '/api/provider/v1/public/doctors?q=asha', null)).json.items[0];
  const days = (await call('GET', `/api/scheduling/v1/public/doctors/${doctor.id}/slots?days=60`, null)).json.days;
  const slot = days.at(-1).slots.at(-1); // far in the future, nobody else is using it
  console.log(`slot ${slot.slotId} (${days.at(-1).date} ${slot.localTime}) ← ${N} concurrent bookings`);

  const started = Date.now();
  const results = await Promise.all(contenders.map((c) => call('POST', '/api/scheduling/v1/appointments', c.token, { slotId: slot.slotId, patientId: c.patientId, reason: 'race' })));
  const ms = Date.now() - started;
  const wins = results.filter((r) => r.status === 201);
  const lost = results.filter((r) => r.status === 409 && r.json.code === 'SLOT_UNAVAILABLE');
  const other = results.filter((r) => !(r.status === 201 || (r.status === 409 && r.json.code === 'SLOT_UNAVAILABLE')));
  console.log(`in ${ms} ms: ${wins.length} booked, ${lost.length} × 409 SLOT_UNAVAILABLE, ${other.length} other ${other.length ? JSON.stringify(other.slice(0, 3).map((o) => [o.status, o.json.code])) : ''}`);

  const winner = wins[0] && contenders[results.indexOf(wins[0])];
  const check = await call('GET', `/api/scheduling/v1/public/slots/${slot.slotId}`, null);
  if (winner) await call('POST', `/api/scheduling/v1/appointments/${wins[0].json.id}/cancel`, winner.token, {});

  const ok = wins.length === 1 && lost.length === N - 1 && other.length === 0 && check.json.available === false;
  console.log(ok ? '\x1b[32mexactly one booking won the race\x1b[0m' : '\x1b[31mRACE TEST FAILED\x1b[0m');
  process.exit(ok ? 0 : 1);
};
main().catch((e) => { console.error(e); process.exit(1); });
