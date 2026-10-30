import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { CITY, patientOtp, uniquePhone } from './helpers';

// Wave 4 (review H-1): a patient downloads a copy of everything the hospital holds for them and their family.
const phone = uniquePhone().replace('+9195', '+9193');
const who = `Dina Export ${phone.slice(-4)}`;

test('a patient downloads their data', async ({ page }) => {
  await page.goto(`${CITY}/login?next=${encodeURIComponent('/care/profile')}`);
  await patientOtp(page, phone);
  await page.getByLabel('Full name').fill(who);
  await page.getByLabel('Date of birth').fill('1988-08-08');
  await page.getByRole('button', { name: 'Create my record' }).click();
  await expect(page.getByText(/Hospital record number/)).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download my data' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^my-health-data-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(data.people[0].patient.fullName).toBe(who);
  expect(Array.isArray(data.people[0].timeline)).toBe(true);
  expect(data.appointments).toHaveProperty('upcoming');
  expect(data.bills).toBeDefined();
});
