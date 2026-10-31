import { expect, test } from '@playwright/test';
import { CITY, env, latestOtp, staffLogin, stamp as mkStamp, uniquePhone } from './helpers';

// E-9: a doctor corrects the diagnoses of a signed visit on the consultation page (with a reason).
const G = 'http://localhost:61000';
const s = mkStamp();
const email = `amend.${s}@citycare.test`;
const call = async (method: string, path: string, token: string | null, body?: unknown) => {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': 'citycare.localhost', 'idempotency-key': crypto.randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { http: r.status, ...(await r.json().catch(() => ({}))) };
};
const staff = async (u: string) => (await (await fetch('http://localhost:61180/realms/medicare/protocol/openid-connect/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: u, password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:citycare' }) })).json()).access_token as string;
const until = async <T,>(fn: () => Promise<T | null | false>, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 800)); } };

test('the doctor amends a signed visit\'s diagnoses', async ({ page }) => {
  // set-up through the API: a doctor, a walk-in, a signed visit with J06.9
  const admin = await staff('admin@citycare.test');
  const desk = await staff('desk@citycare.test');
  const branches = await (await fetch(`${G}/api/tenant/v1/branches`, { headers: { 'x-tenant-host': 'citycare.localhost', authorization: `Bearer ${admin}` } })).json() as { id: string; name: string }[];
  const A = branches.find((b) => b.name === 'Sector 44')!;
  const doc = await call('POST', '/api/provider/v1/doctors', admin, { name: `Dr. Amend ${s}`, email, registrationNo: `AM/${s}`, specialties: [{ code: 'GENERAL_MEDICINE', primary: true }], branches: [{ branchId: A.id, fee: 300 }], consultModes: ['IN_PERSON'] });
  await call('POST', `/api/provider/v1/doctors/${doc.id}/status`, admin, { status: 'ACTIVE' });
  const phone = uniquePhone().replace('+9195', '+9196');
  const since = Date.now();
  await call('POST', '/api/iam/v1/auth/otp/request', null, { phone });
  const pt = (await call('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code: await latestOtp(phone, since) })).accessToken;
  const self = await call('PUT', '/api/patient/v1/me/profile', pt, { fullName: `Amend Patient ${s}`, dob: '1980-01-01', gender: 'FEMALE' });
  const walk = await until(async () => { const r = await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: self.id, walkIn: { doctorId: doc.id, branchId: A.id } }); return r.http === 201 && r; });
  const dr = await until(async () => { try { return await staff(email); } catch { return null; } });
  await call('POST', `/api/scheduling/v1/appointments/${walk.id}/start`, dr);
  const enc = await until(async () => { const e = await call('POST', '/api/records/v1/encounters', dr, { appointmentId: walk.id }); return e.http === 201 && e.encounter; });
  const upd = await call('PATCH', `/api/records/v1/encounters/${enc.id}`, dr, { version: enc.version, notes: 'Sore throat.', diagnoses: [{ code: 'J06.9', isPrimary: true }] });
  await call('POST', `/api/records/v1/encounters/${enc.id}/sign`, dr, { version: upd.version });

  // the doctor corrects it on the page
  await staffLogin(page, CITY, email, `/doctor/consult/${walk.id}`);
  const form = page.locator('form', { has: page.getByLabel('Reason for the amendment') });
  await form.getByLabel('Reason for the amendment').fill('swab confirmed tonsillitis');
  await form.getByLabel('ICD-10 code 2').fill('J03.9');
  await form.getByLabel('Keep diagnosis 2').check();
  await form.locator('input[name="dxPrimary"][value="1"]').check();
  await form.getByRole('button', { name: 'Save amendment' }).click();
  await expect(page.locator('.mc-alert-success')).toContainText('Amendment saved');
  await expect(page.getByText(/swab confirmed tonsillitis \(.*diagnoses/)).toBeVisible();
  const after = await call('GET', `/api/records/v1/encounters/${enc.id}`, dr);
  expect(after.diagnoses.map((d: any) => [d.code, d.isPrimary])).toEqual([['J03.9', true], ['J06.9', false]]);
});
