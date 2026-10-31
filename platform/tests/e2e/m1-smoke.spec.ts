import { expect, test } from '@playwright/test';
import { CITY, latestOtp, stamp as mkStamp, staffLogin, SUN } from './helpers';

// M1 smoke test across zones: staff sign-in via Keycloak, admin zone (branches, staff), hospital isolation,
// patient OTP sign-in and zone access by role.
const stamp = mkStamp();

test('hospital admin manages branches and staff in the admin zone', async ({ page }) => {
  await page.goto(`${CITY}/admin`);
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin/);
  await staffLogin(page, CITY, 'admin@citycare.test');
  await expect(page.getByRole('heading', { name: 'Hospital overview' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Branches' })).toBeVisible();
  await expect(page.getByText('CityCare Clinic').first()).toBeVisible();

  // branches: add, then deactivate
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Branches' }).click();
  const name = `E2E Branch ${stamp}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('Pincode').fill('411001');
  await page.getByRole('button', { name: 'Add branch' }).click();
  await expect(page.getByRole('status')).toContainText(`Branch “${name}” added`);
  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toContainText('Active');
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('Inactive');
  await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('411001'); // PATCH must not wipe the address
  await expect(page.getByRole('navigation', { name: 'Main' }).locator('a[aria-current="page"]')).toHaveText(['Branches']);

  // staff: invite a doctor; the role arrives via events (iam → entitlement)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Staff' }).click();
  const email = `dr.${stamp}@citycare.test`;
  await page.getByLabel('Full name').fill(`Dr. E2E ${stamp}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Role').selectOption('DOCTOR');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByRole('status')).toContainText(`Invited ${email}`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('row', { name: new RegExp(email) })).toContainText('Doctor', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // the same browser is NOT signed in at another hospital (host-only session)
  await page.goto(`${SUN}/admin`);
  await expect(page).toHaveURL(/sunrise\.localhost:3400\/login/);
  await expect(page.getByText('Sunrise Diagnostics')).toBeVisible();
});

test('invited doctor signs in; admin zone is denied for the doctor role', async ({ page }) => {
  const email = `dr.${stamp}@citycare.test`;
  await staffLogin(page, CITY, email, '/');
  // doctors land in the doctor zone; an invited doctor without a directory profile is told so
  await expect(page).toHaveURL(/\/doctor\/schedule/);
  await expect(page.getByRole('heading', { name: 'No doctor profile yet' })).toBeVisible();
  await page.goto(`${CITY}/admin/branches`);
  await expect(page).toHaveURL(/\?denied=admin/);
  await expect(page.getByText("You don't have access to that area.")).toBeVisible();
});

test('patient signs in with phone OTP and cannot open the admin zone', async ({ page }) => {
  const phone = `+9198${stamp}11`.slice(0, 13);
  await page.goto(`${SUN}/login`);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('status')).toContainText('We sent a 6-digit code');
  await page.getByLabel('Code').fill(await latestOtp(phone));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  // patients land in the patient zone (their home), branded for this hospital
  await expect(page).toHaveURL(/sunrise\.localhost:3400\/care$/);
  await expect(page.getByRole('heading', { name: 'Find a doctor' })).toBeVisible();
  await expect(page.getByText('Sunrise Diagnostics').first()).toBeVisible();

  await page.goto(`${SUN}/admin`);
  await expect(page).toHaveURL(/\?denied=admin/);

  await page.getByRole('link', { name: 'Sign out' }).click();
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find a doctor' })).toBeVisible();
});
