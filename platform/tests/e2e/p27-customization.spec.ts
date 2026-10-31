import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CITY, latestOtp, patientOtp, stamp, staffLogin, uniquePhone } from './helpers';

// Phase 27 demo: the admin adds a pre-visit form, a workflow rule and an API key; a patient answers the form before
// the visit; the desk fills in a custom field. Modules reset afterwards.
const mc = (...a: string[]) => execFileSync('node', [fileURLToPath(new URL('../../scripts/mc.mjs', import.meta.url)), ...a], { encoding: 'utf8' });
const G = 'http://localhost:61000';
const H = { 'x-tenant-host': 'citycare.localhost' };
async function api(method: string, path: string, token: string | null, body?: unknown) {
  const r = await fetch(G + path, { method, headers: { ...H, 'idempotency-key': crypto.randomUUID(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { http: r.status, ...(r.status === 204 ? {} : await r.json().catch(() => ({}))) } as any;
}

test.describe.serial('Customization and integrations', () => {
  const s = stamp();
  const phone = uniquePhone();
  let apptId = '';
  test.beforeAll(async () => {
    mc('module', 'enable', 'citycare', 'workflows');
    mc('module', 'enable', 'citycare', 'integrations');
    // a patient with a booking (made through the API: this spec is about the new screens)
    const since = Date.now();
    await api('POST', '/api/iam/v1/auth/otp/request', null, { phone });
    const { accessToken } = await api('POST', '/api/iam/v1/auth/otp/verify', null, { phone, code: await latestOtp(phone, since) });
    const self = await api('PUT', '/api/patient/v1/me/profile', accessToken, { fullName: `Form Visitor ${s}`, dob: '1990-01-01', gender: 'MALE' });
    const doc = (await api('GET', '/api/provider/v1/public/doctors?q=asha', null)).items[0];
    const slot = (await api('GET', `/api/scheduling/v1/public/doctors/${doc.id}/slots?days=10`, null)).days.at(-1).slots.at(-3);
    apptId = (await api('POST', '/api/scheduling/v1/appointments', accessToken, { slotId: slot.slotId, patientId: self.id, paymentMode: 'AT_CLINIC' })).id;
  });
  test.afterAll(() => { mc('module', 'reset', 'citycare', 'workflows'); mc('module', 'reset', 'citycare', 'integrations'); });

  test('the admin adds a form, a rule and an API key', async ({ page }) => {
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/custom-fields');
    await expect(page.getByRole('heading', { name: 'Custom fields and forms', level: 1 })).toBeVisible();
    // the form for every visit (switch off an older one first)
    const on = page.getByRole('row').filter({ hasText: 'Every visit' }).filter({ hasText: 'Yes' });
    while (await on.count()) {
      await on.first().getByRole('button', { name: 'Switch off' }).click();
      await expect(page.locator('.mc-alert-success')).toContainText('Updated');
    }
    await page.getByLabel('Name', { exact: true }).last().fill(`Before your visit ${s}`);
    await page.getByLabel(/Questions, one per line/).fill('What brings you in? | text | | required\nHow long has it been going on? | choice | Days, Weeks, Months');
    await page.getByRole('button', { name: 'Add form' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(`Before your visit ${s}`);

    await page.goto(`${CITY}/admin/workflows`);
    await page.getByLabel('When').selectOption('APPOINTMENT_NO_SHOW');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Rule name').fill(`Second no-show ${s}`);
    await page.getByLabel('Condition 1').selectOption('noShows');
    await page.getByLabel('Test').first().selectOption('gte');
    await page.getByLabel('Value').first().fill('2');
    await page.getByLabel('Tag the patient').check();
    await page.getByLabel('Tag', { exact: true }).fill('no-show risk');
    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByRole('row').filter({ hasText: `Second no-show ${s}` })).toContainText('Missed visits');

    await page.goto(`${CITY}/admin/integrations`);
    await page.getByLabel('Name (who uses it)').fill(`HIS ${s}`);
    await page.getByRole('button', { name: 'Create key' }).click();
    await expect(page.getByText(/API key HIS/)).toBeVisible();
    await expect(page.locator('code').filter({ hasText: /^mck_[a-f0-9]{12}_[A-Za-z0-9_-]{32}$/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('row').filter({ hasText: `HIS ${s}` })).toContainText('Active');
  });

  test('the patient answers the form before the visit', async ({ page }) => {
    await page.goto(`${CITY}/login?next=${encodeURIComponent('/care/appointments')}`);
    await patientOtp(page, phone);
    await page.waitForURL(/\/care\/appointments/);
    await page.getByRole('link', { name: 'Before your visit' }).first().click();
    await expect(page.getByRole('heading', { name: `Before your visit ${s}` })).toBeVisible();
    await page.getByLabel('What brings you in? *').fill('Knee pain when climbing stairs');
    await page.getByLabel('How long has it been going on?').selectOption('Weeks');
    await page.getByRole('button', { name: 'Send to the doctor' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('the doctor will see your answers');
    await expect(page.getByRole('link', { name: 'Your answers' }).first()).toBeVisible();
  });

  test('the desk sees the answers on the patient page', async ({ page }) => {
    await staffLogin(page, CITY, 'desk@citycare.test', `/desk/patients?q=${encodeURIComponent(phone)}`);
    await page.getByRole('link', { name: `Details for Form Visitor ${s}` }).click();
    await expect(page.getByRole('heading', { name: `Form Visitor ${s}` })).toBeVisible();
    await expect(page.getByText('Knee pain when climbing stairs')).toBeVisible();
    await api('POST', `/api/scheduling/v1/appointments/${apptId}/cancel`, null, {}).catch(() => undefined);
  });
});
