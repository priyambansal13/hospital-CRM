import { expect, test } from '@playwright/test';
import { CITY, env, latestOtp, staffLogin, stamp, uniquePhone } from './helpers';

// Phase 25 demo (doctor side): a recorded mock consultation becomes an editable SOAP draft and prescription; the
// doctor changes the antibiotic, takes it over into the visit notes and sees the prescription form filled in.
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const H = { 'x-tenant-host': 'citycare.localhost' };
const sfx = stamp();
const doctorEmail = `e2e.scribe.${sfx}@citycare.test`;
let appointmentId = '';

const CONSULT = `Doctor: Good morning. What brings you in today?
Patient: I have had a sore throat and fever for three days.
Doctor: Your temperature is 38.4, pulse 96, BP 122/80. Throat is red and the tonsils are swollen.
Doctor: This looks like acute tonsillitis.
Doctor: I will start amoxicillin 500 mg three times a day for 5 days, and paracetamol 650 mg when needed for fever for 3 days.
Doctor: Drink warm fluids and rest. Come back in 5 days if you are not better.`;

/** A WAV file (one second of silence) carrying the transcript in its comment: what the dev model "hears". */
function mockRecording(transcript: string) {
  const pcm = Buffer.alloc(16000);
  const text = Buffer.from(`${transcript}\0`, 'utf8');
  const icmt = Buffer.concat([Buffer.from('ICMT'), Buffer.alloc(4), text, Buffer.alloc(text.length % 2)]);
  icmt.writeUInt32LE(text.length, 4);
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.alloc(4), Buffer.from('INFO'), icmt]);
  list.writeUInt32LE(4 + icmt.length, 4);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(8000, 12); fmt.writeUInt32LE(16000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const data = Buffer.concat([Buffer.from('data'), Buffer.alloc(4), pcm]);
  data.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, list, data]);
  const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), body]);
  riff.writeUInt32LE(body.length, 4);
  return riff;
}

async function staff(email: string) {
  return (await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:citycare' }) })).json()).access_token as string | undefined;
}
async function api(method: string, path: string, token: string | null, body?: unknown) {
  const r = await fetch(G + path, { method, headers: { ...H, 'idempotency-key': crypto.randomUUID(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { http: r.status, ...(Array.isArray(j) ? { list: j } : j) } as Record<string, any>;
}
const retry = async <T,>(fn: () => Promise<T | false | undefined>) => { for (let i = 0; i < 30; i++) { const v = await fn(); if (v) return v; await new Promise((ok) => setTimeout(ok, 1000)); } throw new Error('gave up'); };

test.describe.serial('AI scribe', () => {
  test.beforeAll(async () => {
    const [admin, desk] = await Promise.all([staff('admin@citycare.test'), staff('desk@citycare.test')]);
    const sector44 = (await api('GET', '/api/tenant/v1/branches', admin!)).list.find((b: { name: string }) => b.name === 'Sector 44');
    const d = await api('POST', '/api/provider/v1/doctors', admin!, { name: `Dr. Scribe E2E ${sfx}`, email: doctorEmail, registrationNo: `SE/${sfx}`, specialties: [{ code: 'GENERAL_MEDICINE', primary: true }], branches: [{ branchId: sector44.id, fee: 300 }], consultModes: ['IN_PERSON'] });
    await api('POST', `/api/provider/v1/doctors/${d.id}/status`, admin!, { status: 'ACTIVE' });
    await retry(() => staff(doctorEmail));
    const phone = uniquePhone();
    const since = Date.now();
    await api('POST', '/api/iam/v1/auth/otp/request', null, { phone });
    const p = (await api('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code: await latestOtp(phone, since) })).accessToken as string;
    const self = await api('PUT', '/api/patient/v1/me/profile', p, { fullName: `Scribe Visitor ${sfx}`, dob: '1980-01-01' });
    appointmentId = (await retry(async () => { const r = await api('POST', '/api/scheduling/v1/desk/appointments', desk!, { patientId: self.id, walkIn: { doctorId: d.id, branchId: sector44.id } }); return r.http === 201 && r; })).id;
  });

  test('a recorded consultation becomes draft notes and a prescription the doctor edits and takes over', async ({ page }) => {
    await staffLogin(page, CITY, doctorEmail, `/doctor/consult/${appointmentId}`);
    await page.getByRole('button', { name: 'Start visit' }).click();
    const panel = page.locator('section.mc-card').filter({ hasText: 'AI scribe' });
    await panel.getByRole('button', { name: 'Record consent' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Consent recorded');

    await panel.locator('input[type="file"]').setInputFiles({ name: 'consultation.wav', mimeType: 'audio/wav', buffer: mockRecording(CONSULT) });
    await panel.getByRole('button', { name: 'Make draft notes' }).click();
    const form = page.getByLabel('Draft notes');
    await expect(form.getByLabel('Subjective (complaint, history)')).toHaveValue(/sore throat and fever for three days/);
    await expect(form.getByLabel('Temp °C')).toHaveValue('38.4');
    await expect(form.getByLabel('Diagnosis 1')).toHaveValue('Acute tonsillitis');
    await expect(form.getByText('code found')).toBeVisible();
    await expect(form.getByText('formulary: Amoxicillin')).toBeVisible();

    // the doctor prefers azithromycin
    await form.locator('input[name="drug0"]').fill('Azithromycin');
    await form.locator('input[name="dosage0"]').fill('1-0-0');
    await form.locator('input[name="days0"]').fill('3');
    await form.getByRole('button', { name: 'Use in visit notes' }).click();

    await expect(page.locator('.mc-alert-success').filter({ hasText: 'Review the prescription below' })).toBeVisible();
    await expect(page.locator('section.mc-card').filter({ hasText: 'AI scribe' })).toContainText('Draft taken over into the visit notes (with your changes)');
    await expect(page.locator('input[name="drug0"]').last()).toHaveValue('Azithromycin');
    await expect(page.locator('input[name="drug1"]').last()).toHaveValue('paracetamol');
  });
});
