import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CITY, staffLogin } from './helpers';

// Phase 29 demo: the admin reads the analytics dashboard and explores a metric, then asks the Ops assistant a
// question and sees the answer with its table; care-gap reminders wait for approval. Modules reset afterwards.
const mc = (...a: string[]) => execFileSync('node', [fileURLToPath(new URL('../../scripts/mc.mjs', import.meta.url)), ...a], { encoding: 'utf8' });

test.describe.serial('Analytics and the Ops assistant', () => {
  test.beforeAll(() => { mc('module', 'enable', 'citycare', 'analytics'); mc('module', 'enable', 'citycare', 'ai_ops'); });
  test.afterAll(() => { mc('module', 'reset', 'citycare', 'ai_ops'); mc('module', 'reset', 'citycare', 'analytics'); });

  test('the admin reads the dashboard and explores no-shows by weekday', async ({ page }) => {
    test.setTimeout(120_000);
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/analytics');
    await expect(page.getByRole('heading', { name: 'Analytics', exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('No-show rate').first()).toBeVisible();
    await page.getByRole('link', { name: 'Last 90 days' }).click();
    await expect(page.getByRole('link', { name: 'Last 90 days' })).toHaveAttribute('aria-current', 'page');
    await page.getByLabel('Metric').selectOption('no_show_rate');
    await page.getByLabel('Split by').selectOption('weekday');
    await page.getByRole('button', { name: 'Show', exact: true }).last().click();
    const table = page.getByRole('table');
    await expect(table).toContainText('Mon');
    await expect(table).toContainText('Sun');
    await expect(page.getByRole('link', { name: 'Download CSV' })).toBeVisible();
  });

  test('the admin asks the Ops assistant', async ({ page }) => {
    test.setTimeout(120_000);
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/ops');
    await page.getByLabel('Your question').fill('Appointments by department in the last 30 days');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const answer = page.locator('#answer');
    await expect(answer).toContainText('Appointments by department', { timeout: 30_000 });
    await expect(answer).toContainText('Every figure was checked against the reports');
    await expect(answer.getByRole('table')).toBeVisible();
    await answer.getByRole('button', { name: 'Helpful', exact: true }).click();
    await expect(page.locator('#answer')).toContainText('You rated this helpful');
    await expect(page.getByRole('form', { name: 'Diabetes: HbA1c every 6 months' })).toBeVisible();
  });
});
