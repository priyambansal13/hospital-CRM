import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CITY, patientOtp, stamp, staffLogin, uniquePhone } from './helpers';

// Phase 26 demo: the hospital switches memberships on; a patient compares tiers, joins Care+ and pays (simulated
// Razorpay), then sees the benefits; the admin sees the member and the monthly revenue. Module reset afterwards (other
// specs book further ahead than a non-member may).
const mc = (...a: string[]) => execFileSync('node', [fileURLToPath(new URL('../../scripts/mc.mjs', import.meta.url)), ...a], { encoding: 'utf8' });

test.describe.serial('Memberships', () => {
  const name = `Member Visitor ${stamp()}`;
  test.beforeAll(async () => {
    mc('module', 'enable', 'citycare', 'memberships');
    for (let i = 0; i < 30; i++) {
      const r = await fetch('http://localhost:61000/api/billing/v1/public/membership-plans', { headers: { 'x-tenant-host': 'citycare.localhost' } });
      if (r.ok && ((await r.json()) as unknown[]).length) break;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  });
  test.afterAll(() => { mc('module', 'reset', 'citycare', 'memberships'); });

  test('a patient compares tiers, joins Care+ and pays', async ({ page }) => {
    await page.goto(`${CITY}/login?next=${encodeURIComponent('/care/membership')}`);
    await patientOtp(page, uniquePhone());
    await page.waitForURL(/\/care\/membership/);
    // first visit: the profile the hospital record needs
    await page.goto(`${CITY}/care/profile`);
    await page.getByLabel('Full name').fill(name);
    await page.getByLabel('Date of birth').fill('1979-09-09');
    await page.getByRole('button', { name: 'Create my record' }).click();
    await expect(page.getByLabel('Full name')).toHaveValue(name);
    await page.goto(`${CITY}/care/membership`);
    const tiers = page.getByLabel('Membership tiers');
    await expect(tiers).toContainText('Care+');
    await expect(tiers).toContainText('Family+');
    await expect(tiers).toContainText('15% off lab tests');
    await page.getByRole('button', { name: 'Join Care+' }).click();
    await expect(page.getByRole('heading', { name: 'Pay for your membership' })).toBeVisible();
    await page.getByRole('button', { name: 'Pay ₹499' }).click();
    await expect(page.getByText(/Welcome to Care\+/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: 'See your benefits' }).click();
    await expect(page.getByRole('heading', { name: 'You are a Care+ member' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Renew Care+' })).toBeVisible();
  });

  test('the admin sees the tiers, the member and the revenue', async ({ page }) => {
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/memberships');
    await expect(page.getByRole('heading', { name: 'Memberships', level: 1 })).toBeVisible();
    await expect(page.getByText('Active members')).toBeVisible();
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Edit' }).first().click();
    await expect(page.getByRole('button', { name: /^Save / })).toBeVisible();
  });
});
