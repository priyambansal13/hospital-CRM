#!/usr/bin/env node
// Reminder test (Phase 9): a booking gets 24 h and 2 h reminders scheduled; making one due sends it; a reminder for an
// appointment that was cancelled (even if the cancel event was missed) is SKIPPED by the dispatcher's re-check.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..');
const G = 'http://localhost:61000';
const H = { 'x-tenant-host': 'citycare.localhost' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
const call = async (method, path, token, body) => {
  const r = await fetch(G + path, { method, headers: { ...H, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
const sms = async (phone) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.slice(1)}@sms.medicare.local`)}`)).json()).messages ?? [];
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${msg}\x1b[0m`); if (!ok) failures++; };

const phone = '+9192' + Date.now().toString().slice(-8);
await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
await sleep(500);
const code = (await sms(phone))[0].Snippet.match(/\d{6}/)[0];
const tok = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code })).accessToken;
const self = await call('PUT', '/api/patient/v1/me/profile', tok, { fullName: 'Reminder Test', dob: '1980-01-01' });
await sleep(1500);
const doc = (await call('GET', '/api/provider/v1/public/doctors?q=asha')).items[0];
const days = (await call('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=14`)).days;
// the first day at least 4 days out with two free times (earlier runs fill days up)
const day = days.slice(4).find((d) => d.slots.length >= 2);
const [s1, s2] = [day.slots[0], day.slots[1]];
const a1 = await call('POST', '/api/scheduling/v1/appointments', tok, { slotId: s1.slotId, patientId: self.id });
const a2 = await call('POST', '/api/scheduling/v1/appointments', tok, { slotId: s2.slotId, patientId: self.id });
await sleep(3000);

const planned = psql(`SELECT template_key || ':' || channel FROM notification.notifications WHERE related_id = '${a1.id}' AND status = 'SCHEDULED' ORDER BY 1`).split('\n');
check(planned.includes('reminder_24h:SMS') && planned.includes('reminder_24h:EMAIL') && planned.includes('reminder_2h:SMS'), `reminders scheduled for ${a1.appointmentNo}: ${planned.join(', ')}`);
const at = psql(`SELECT to_char(send_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') FROM notification.notifications WHERE related_id = '${a1.id}' AND template_key = 'reminder_2h'`);
check(at === new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date(Date.parse(a1.startsAt) - 2 * 3600_000)).replace(',', ''), `2 h reminder is due at ${at} IST`);

// make the 2 h reminder due now → dispatcher sends it within ~5 s
psql(`UPDATE notification.notifications SET send_at = now() WHERE related_id = '${a1.id}' AND template_key = 'reminder_2h'`);
let reminder;
for (let i = 0; i < 20 && !reminder; i++) { await sleep(1000); reminder = (await sms(phone)).find((m) => /Please arrive 10 minutes early/.test(m.Snippet)); }
check(!!reminder, `2 h reminder SMS delivered: "${reminder?.Snippet.slice(0, 90)}…"`);

// safety net: cancel a2, then force-schedule a reminder as if the cancel event had been missed → must be SKIPPED
await call('POST', `/api/scheduling/v1/appointments/${a2.id}/cancel`, tok, {});
await sleep(2500);
check(psql(`SELECT count(*) FROM notification.notifications WHERE related_id = '${a2.id}' AND template_key LIKE 'reminder%' AND status = 'CANCELLED'`) === '3', 'cancelling cancels its scheduled reminders');
psql(`UPDATE notification.notifications SET status = 'SCHEDULED', send_at = now() WHERE related_id = '${a2.id}' AND template_key = 'reminder_2h'`);
let status;
for (let i = 0; i < 20 && status !== 'SKIPPED'; i++) { await sleep(1000); status = psql(`SELECT status || ' ' || coalesce(last_error, '') FROM notification.notifications WHERE related_id = '${a2.id}' AND template_key = 'reminder_2h'`); if (status.startsWith('SKIPPED')) status = 'SKIPPED'; }
check(status === 'SKIPPED', 'a reminder for a cancelled appointment is skipped, not sent');

await call('POST', `/api/scheduling/v1/appointments/${a1.id}/cancel`, tok, {});
console.log(failures ? `\x1b[31m${failures} failure(s)\x1b[0m` : '\x1b[32mreminders ok\x1b[0m');
process.exit(failures ? 1 : 0);
