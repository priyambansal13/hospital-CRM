import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { staffLogin, SUN } from './helpers';

// Phase 17 demo: Sunrise on Clinic Starter (no lab, upsell shows Hospital Professional) → moved to Hospital
// Professional (lab zone and lab catalog appear) → downgraded (lab read-only: worklist viewable, nothing to scan,
// patients can't book) → back to Hospital Professional (the demo default).
const PLATFORM = new URL('../..', import.meta.url).pathname;
const plan = (code: string) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), 'plan', 'set', 'sunrise', code, '--reason', 'p17 e2e'], { encoding: 'utf8' });

test.describe.serial('plans and module lifecycle', () => {
  test.afterAll(() => { plan('HOSPITAL_PRO'); });

  test('Clinic Starter: the admin sees the plan and what an upgrade adds', async ({ page }) => {
    plan('CLINIC_STARTER');
    await staffLogin(page, SUN, 'admin@sunrise.test', '/admin/plan');
    await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
    await expect(page.getByText('Clinic Starter · Clinic')).toBeVisible();
    const lab = page.getByRole('row', { name: /^Diagnostics and lab / });
    await expect(lab).toContainText(/Read only|Not in plan/);
    await expect(page.getByRole('complementary', { name: 'Upgrade for Diagnostics and lab' })).toContainText('Move to Hospital Professional: ₹24,999/month');
    await expect(page.getByRole('row', { name: /^Branches / })).toContainText('1 branch');
    await page.goto(`${SUN}/admin`);
    await expect(page.getByText('Modules in your plan')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Home sample collection' })).toContainText(/Read only|Not in plan/);
  });

  test('upgrade to Hospital Professional: the lab is switched on', async ({ page }) => {
    plan('HOSPITAL_PRO');
    await staffLogin(page, SUN, 'admin@sunrise.test', '/admin/plan');
    await expect(page.getByText('Hospital Professional · Multi-specialty hospital')).toBeVisible();
    await expect(page.getByRole('row', { name: /^Diagnostics and lab / })).toContainText('Active');
    await page.goto(`${SUN}/admin/lab-catalog`);
    await expect(page.getByText('Complete Blood Count').first()).toBeVisible();
    await page.goto(`${SUN}/lab`);
    await expect(page.getByRole('heading', { name: 'Lab worklist' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Read-only module' })).toHaveCount(0);
    await page.goto(`${SUN}/care/tests`);
    await expect(page.getByRole('heading', { name: 'Lab tests' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Complete Blood Count' })).toBeVisible();
  });

  test('downgrade: the lab becomes read-only, data intact', async ({ page }) => {
    plan('CLINIC_STARTER');
    await staffLogin(page, SUN, 'admin@sunrise.test', '/lab');
    await expect(page.getByRole('heading', { name: 'Lab worklist' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Read-only module' })).toContainText('no longer in your hospital');
    await expect(page.getByRole('form', { name: 'Scan' })).toHaveCount(0);
    await page.goto(`${SUN}/admin/plan`);
    await expect(page.getByRole('row', { name: /^Diagnostics and lab / })).toContainText('Read only');
    await page.goto(`${SUN}/care/tests`);
    await expect(page.getByText('Online lab test booking is not available at this hospital.')).toBeVisible();
  });
});
