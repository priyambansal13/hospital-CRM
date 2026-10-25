import { expect, test } from '@playwright/test';
import { CITY, env, staffLogin, stamp as mkStamp, SUN } from './helpers';

// Phase 6: admin adds and publishes a doctor; patients find them by specialty, filters and profile; other hospitals don't.
const stamp = mkStamp();
const doctorName = `Dr. Meera Iyer ${stamp}`;

test.describe.serial('doctor directory', () => {
  // unpublish the test doctor afterwards: leftovers pile up in Dermatology and push new doctors off the first page
  test.afterAll(async () => {
    const t = await fetch('http://localhost:61180/realms/medicare/protocol/openid-connect/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: 'admin@citycare.test', password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:citycare' }) }).then((r) => r.json());
    const h = { authorization: `Bearer ${t.access_token}`, 'x-tenant-host': 'citycare.localhost' };
    const list = await fetch(`http://localhost:61000/api/provider/v1/doctors?q=${encodeURIComponent(doctorName)}`, { headers: h }).then((r) => r.json());
    for (const d of list.items ?? []) {
      if (d.name === doctorName) await fetch(`http://localhost:61000/api/provider/v1/doctors/${d.id}/status`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'INACTIVE' }) });
    }
  });

  test('admin adds a doctor as a draft, then publishes the profile', async ({ page }) => {
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/doctors');
    await expect(page.getByRole('heading', { name: 'Doctors', exact: true })).toBeVisible();
    await page.getByLabel('Email (for sign-in)').fill(`meera.${stamp}@citycare.test`);
    await page.getByLabel('Medical registration no.').fill(`KMC/${stamp}`);
    await page.getByLabel('Full name').fill(doctorName);
    await page.getByLabel('Gender').selectOption('FEMALE');
    await page.getByLabel('Experience (years)').fill('9');
    await page.getByLabel('Qualifications').fill('MBBS, MD (Dermatology)');
    await page.getByLabel('Languages').fill('en, ta');
    await page.getByRole('checkbox', { name: 'Dermatology' }).check();
    await page.getByRole('checkbox', { name: 'Sector 44' }).check();
    await page.getByLabel('Sector 44 fee').fill('800');
    await page.getByLabel('About the doctor').fill('Skin, hair and nail care for adults and children.');
    await page.getByRole('button', { name: 'Add doctor' }).click();

    await expect(page.getByRole('heading', { name: doctorName })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Doctor added as a draft');
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();

    // a draft is invisible to patients
    const anon = await page.context().browser()!.newPage();
    await anon.goto(`${CITY}/care/doctors?specialty=DERMATOLOGY`);
    await expect(anon.getByText(doctorName)).toHaveCount(0);

    await page.getByRole('button', { name: 'Publish profile' }).click();
    await expect(page.getByRole('status')).toContainText('Published');
    await expect(page.getByText('Published', { exact: true })).toBeVisible();
    await anon.close();
  });

  test('a patient (not signed in) finds the doctor by specialty and filters and opens the profile', async ({ page }) => {
    await page.goto(`${CITY}/care`);
    await expect(page.getByRole('heading', { name: 'Find a doctor' })).toBeVisible();
    await page.getByRole('link', { name: /Dermatology/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Dermatology doctors' })).toBeVisible();
    await expect(page.getByRole('link', { name: doctorName })).toBeVisible();

    // filters narrow results (language)
    await page.getByLabel('Language').selectOption('ta');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByRole('link', { name: doctorName })).toBeVisible();
    await page.getByLabel('Language').selectOption('bn');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByText('No doctors match these filters.')).toBeVisible();

    await page.goto(`${CITY}/care/doctors?q=${encodeURIComponent('meera')}`);
    await page.getByRole('link', { name: doctorName }).click();
    await expect(page.getByRole('heading', { name: doctorName })).toBeVisible();
    await expect(page.getByRole('row', { name: /Sector 44/ })).toContainText('₹800');
    await expect(page.getByText('Speaks English, Tamil')).toBeVisible();
    await expect(page.getByText(`meera.${stamp}@citycare.test`)).toHaveCount(0); // staff-only fields never shown
  });

  test('another hospital never shows this doctor', async ({ page }) => {
    await page.goto(`${SUN}/care/doctors?q=${encodeURIComponent('meera')}`);
    await expect(page.getByText(doctorName)).toHaveCount(0);
    const id = await (async () => {
      const p2 = await page.context().newPage();
      await p2.goto(`${CITY}/care/doctors?q=${encodeURIComponent('meera')}`);
      const href = await p2.getByRole('link', { name: doctorName }).getAttribute('href');
      await p2.close();
      return href!.split('/').pop();
    })();
    const res = await page.goto(`${SUN}/care/doctors/${id}`);
    expect(res?.status()).toBe(404);
  });

  test('admin adds a specialty and hides it from patients', async ({ page }) => {
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/specialties');
    const name = `Sleep Medicine ${stamp}`;
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Short description').fill('Snoring and sleep problems');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('status')).toContainText(`Added ${name}`);
    const row = page.getByRole('row', { name: new RegExp(name) });
    await row.getByRole('button', { name: 'Hide' }).click();
    await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('Hidden');
  });
});
