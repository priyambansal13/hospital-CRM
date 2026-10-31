import { expect, test } from '@playwright/test';
import { CITY, staffLogin, stamp as mkStamp } from './helpers';

// Phase 7: a doctor sets weekly hours and leave in the doctor zone; slots open/close; admins manage any schedule.
const stamp = mkStamp();
const name = `Dr. Vikram Sethi ${stamp}`;
const email = `vikram.${stamp}@citycare.test`;
const nextMonday = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
})();

test.describe.serial('doctor schedule', () => {
  test('admin adds the doctor (login is created)', async ({ page }) => {
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/doctors');
    await page.getByLabel('Email (for sign-in)').fill(email);
    await page.getByLabel('Medical registration no.').fill(`PMC/${stamp}`);
    await page.getByLabel('Full name').fill(name);
    await page.getByRole('checkbox', { name: 'General Medicine' }).check();
    await page.getByRole('checkbox', { name: 'Sector 44' }).check();
    await page.getByLabel('Sector 44 fee').fill('600');
    await page.getByRole('button', { name: 'Add doctor' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
  });

  test('the doctor sets weekly hours and leave; overlaps are rejected', async ({ page }) => {
    await staffLogin(page, CITY, email, '/doctor');
    // a doctor with a profile lands on "Today", then opens their schedule
    await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / })).toBeVisible();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My schedule' }).click();
    await expect(page).toHaveURL(/\/doctor\/schedule/);
    await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible();
    await expect(page.getByText('No working hours yet')).toBeVisible();

    // defaults: Mon–Fri 10:00–13:00, 15-minute slots
    await page.getByRole('button', { name: 'Add hours' }).click();
    await expect(page.getByRole('status')).toContainText(/Hours added: \d+ slots opened/);
    await expect(page.getByRole('row', { name: /Monday 10:00–13:00 Sector 44 15 min/ })).toBeVisible();

    // overlapping hours on Wednesday are rejected
    for (const d of ['Mon', 'Tue', 'Thu', 'Fri']) await page.getByRole('checkbox', { name: d, exact: true }).uncheck();
    await page.getByLabel('Start', { exact: true }).fill('12:00');
    await page.getByLabel('End', { exact: true }).fill('14:00');
    await page.getByRole('button', { name: 'Add hours' }).click();
    await expect(page.getByText(/overlaps existing hours 10:00–13:00 at Sector 44/)).toBeVisible();

    // leave next Monday blocks that day's 12 slots; cancelling reopens them
    await page.getByLabel('From', { exact: true }).fill(nextMonday);
    await page.getByLabel('To', { exact: true }).fill(nextMonday);
    await page.getByLabel('Reason (optional)').fill('Conference');
    await page.getByRole('button', { name: 'Add leave' }).click();
    await expect(page.getByRole('status')).toContainText('Leave added: 12 slots blocked');
    await expect(page.getByText('12 blocked')).toBeVisible();
    await page.getByRole('row', { name: /Conference/ }).getByRole('button', { name: 'Cancel leave' }).click();
    await expect(page.getByRole('status')).toContainText('Leave cancelled: 12 slots reopened');

    // the admin zone is still off-limits for a doctor
    await page.goto(`${CITY}/admin/schedules`);
    await expect(page).toHaveURL(/\?denied=admin/);
  });

  test('admin sees every schedule and can edit this doctor’s hours', async ({ page }) => {
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/schedules');
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toContainText('5 blocks');
    await row.getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await page.getByRole('row', { name: /Friday 10:00–13:00/ }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('status')).toContainText(/Hours removed \(\d+ open slots closed\)/);
    await expect(page.getByRole('row', { name: /Friday 10:00–13:00/ })).toHaveCount(0);
  });
});
