import { expect, test } from '@playwright/test';
import { CITY, env, latestOtp, staffLogin, stamp, uniquePhone } from './helpers';

// Phase 24 demo (doctor side): the doctor opens today's visit, makes the pre-visit summary, follows a citation to the
// record it came from, and rates the summary.
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const H = { 'x-tenant-host': 'citycare.localhost' };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
let appointmentId = '';
let encounterId = '';

async function staff(email: string) {
  return (await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:citycare' }) })).json()).access_token as string;
}
async function api(method: string, path: string, token: string | null, body?: unknown) {
  const r = await fetch(G + path, { method, headers: { ...H, 'idempotency-key': crypto.randomUUID(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { http: r.status, ...(r.status === 204 ? {} : await r.json().catch(() => ({}))) };
}
const retry = async <T,>(fn: () => Promise<T | false>) => { for (let i = 0; i < 20; i++) { const v = await fn(); if (v) return v; await new Promise((ok) => setTimeout(ok, 1000)); } throw new Error('gave up'); };

test.describe.serial('Doctor copilot', () => {
  test.beforeAll(async () => {
    const [desk, asha] = await Promise.all([staff('desk@citycare.test'), staff('asha.rao@citycare.test')]);
    const phone = uniquePhone();
    const since = Date.now();
    await api('POST', '/api/iam/v1/auth/otp/request', null, { phone });
    const { accessToken: p } = await api('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code: await latestOtp(phone, since) }) as unknown as { accessToken: string };
    const self = await api('PUT', '/api/patient/v1/me/profile', p, { fullName: `Copilot Visitor ${stamp()}`, dob: '1966-06-06', gender: 'FEMALE' }) as unknown as { id: string };
    await api('POST', `/api/patient/v1/me/patients/${self.id}/allergies`, p, { substance: 'Sulfa drugs', severity: 'MODERATE', reaction: 'hives' });
    const branch = ((await api('GET', '/api/diagnostics/v1/public/lab-branches', null)) as unknown as Record<string, { id: string; name: string }>);
    const sector44 = Object.values(branch).find((b) => b?.name === 'Sector 44')!;
    const me = await api('GET', '/api/scheduling/v1/me/doctor', asha) as unknown as { id: string };
    const walkIn = () => retry(async () => { const r = await api('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: self.id, walkIn: { doctorId: me.id, branchId: sector44.id } }); return r.http === 201 && (r as unknown as { id: string }); });
    // an earlier visit: hypertension, amlodipine, signed and completed
    const v1 = await walkIn();
    const e = await retry(async () => { const r = await api('POST', '/api/records/v1/encounters', asha, { appointmentId: v1.id }); return r.http === 201 && (r as unknown as { encounter: { id: string; version: number } }).encounter; });
    encounterId = e.id;
    const u = await api('PATCH', `/api/records/v1/encounters/${e.id}`, asha, { version: e.version, chiefComplaint: 'Headaches', diagnoses: [{ code: 'I10', isPrimary: true }] }) as unknown as { encounter?: { version: number }; version?: number };
    await api('POST', `/api/records/v1/encounters/${e.id}/prescriptions`, asha, { items: [{ drugName: 'Amlodipine', strength: '5 mg', form: 'tablet', dosage: '0-0-1', durationDays: 60 }], advice: 'Less salt, check BP weekly', followUpOn: today() });
    await api('POST', `/api/records/v1/encounters/${e.id}/sign`, asha, { version: (u.encounter ?? u).version });
    await api('POST', `/api/scheduling/v1/appointments/${v1.id}/start`, asha);
    await api('POST', `/api/scheduling/v1/appointments/${v1.id}/complete`, asha);
    appointmentId = (await walkIn()).id;
  });

  test('the doctor makes the pre-visit summary, follows a citation, and rates it', async ({ page }) => {
    await staffLogin(page, CITY, 'asha.rao@citycare.test', `/doctor/consult/${appointmentId}`);
    const panel = page.locator('section.mc-card').filter({ hasText: 'Copilot: pre-visit summary' });
    await expect(panel).toContainText('not added to the visit notes');
    await panel.getByRole('button', { name: 'Make pre-visit summary' }).click();

    const summary = page.getByLabel('Pre-visit summary');
    await expect(summary.getByRole('heading', { name: 'Active problems' })).toBeVisible();
    await expect(summary).toContainText('(I10)');
    await expect(summary).toContainText('Amlodipine 5 mg');
    await expect(summary).toContainText('Sulfa drugs: moderate, hives');
    await expect(summary).toContainText(`follow-up on ${today()}`);
    const cite = summary.locator('a.mc-cite', { hasText: 'Visit' }).first();
    await expect(cite).toHaveAttribute('href', new RegExp(`#enc-${encounterId}$`));

    await panel.getByRole('button', { name: 'Useful' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Thanks');
    await expect(panel).toContainText('Marked useful');

    await cite.click();
    await expect(page.locator(`#enc-${encounterId}`)).toContainText('Headaches');
  });
});
