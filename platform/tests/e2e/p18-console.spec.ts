import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { env, staffLogin } from './helpers';

// Phase 18 demo: a MediCare product manager builds "Diagnostic Center – Professional" in the console without code →
// an approver (second person) publishes it → support simulates and moves Greenleaf onto it → Greenleaf's admin sees it.
const PLATFORM = new URL('../..', import.meta.url).pathname;
const mc = (...args: string[]) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...args], { encoding: 'utf8' });
const HQ = 'http://medicare.localhost:3400';
const GREEN = 'http://greenleaf.localhost:3400';
const G = 'http://localhost:61000';
const CODE = `DIAG_CENTER_PRO_E${Date.now().toString().slice(-5)}`;
let versionUrl = '';

async function token(email: string, org: string) {
  const r = await fetch('http://localhost:61180/realms/medicare/protocol/openid-connect/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: `openid organization:${org}` }) });
  return ((await r.json()) as { access_token: string }).access_token;
}
async function call(method: string, path: string, t: string, body?: unknown) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': 'medicare.localhost', authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({})) as Promise<any>;
}

test.describe.serial('platform console: build, approve, assign a plan', () => {
  test.beforeAll(async () => {
    const tenants = execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' });
    if (!tenants.includes('"medicare"')) mc('seed', 'demo');
    if (!tenants.includes('"greenleaf"')) mc('tenant', 'create', 'greenleaf', '--name', 'Greenleaf Clinic', '--admin', 'admin@greenleaf.test', '--plan', 'CLINIC_STARTER');
    const admin = await token('admin@medicare.test', 'medicare');
    for (const [email, name, role] of [['product@medicare.test', 'Priya Product', 'PLATFORM_PRODUCT'], ['approver@medicare.test', 'Arjun Approver', 'PLATFORM_APPROVER'], ['support@medicare.test', 'Sana Support', 'PLATFORM_SUPPORT']]) {
      await call('POST', '/api/iam/v1/staff/invites', admin, { email, name, roles: [role] });
    }
    mc('plan', 'set', 'greenleaf', 'CLINIC_STARTER', '--reason', 'p18 e2e start');
  });

  test.afterAll(async () => {
    mc('plan', 'set', 'greenleaf', 'CLINIC_STARTER', '--reason', 'p18 e2e clean-up');
    const ap = await token('approver@medicare.test', 'medicare');
    const plan = ((await call('GET', '/api/subscription/v1/platform/plans', ap)) as any[]).find((p) => p.code === CODE);
    const admin = await token('admin@medicare.test', 'medicare');
    for (const v of plan?.versions ?? []) {
      if (v.status === 'PUBLISHED') await call('POST', `/api/subscription/v1/platform/versions/${v.id}/retire`, ap);
      if (v.status === 'PENDING') await call('POST', `/api/subscription/v1/platform/versions/${v.id}/reject`, ap, { note: 'e2e clean-up' });
      if (v.status !== 'PUBLISHED' && v.status !== 'RETIRED') await call('DELETE', `/api/subscription/v1/platform/versions/${v.id}`, admin);
    }
  });

  test('a product manager builds the plan and submits it', async ({ page }) => {
    await staffLogin(page, HQ, 'product@medicare.test', '/platform/plans');
    await expect(page.getByRole('heading', { name: 'Plans', exact: true })).toBeVisible();
    const form = page.getByRole('form', { name: 'New plan' });
    await form.getByLabel('Name').fill('Diagnostic Center – Professional');
    await form.getByLabel('Code').fill(CODE);
    await form.getByLabel('Edition').selectOption('DIAGNOSTIC_CENTER');
    await form.getByLabel('Tier').fill('Professional');
    await form.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Draft created');
    versionUrl = page.url().split('?')[0];

    const builder = page.getByRole('form', { name: 'Plan version' });
    await builder.getByRole('checkbox', { name: 'Home sample collection', exact: true }).check();
    await builder.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByRole('alert', { name: 'Problems' })).toContainText('Home sample collection needs Diagnostics and lab');

    await page.getByRole('form', { name: 'Plan version' }).getByRole('checkbox', { name: 'Diagnostics and lab', exact: true }).check();
    await page.getByRole('form', { name: 'Plan version' }).getByRole('checkbox', { name: 'Billing and payments', exact: true }).check();
    await page.getByLabel('List price (₹ per month)').fill('14999');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Draft saved');
    await page.getByLabel('Branches limit').fill('3');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Draft saved');
    await expect(page.getByLabel('Branches limit')).toHaveValue('3');

    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('someone else must approve');
    await expect(page.getByText('waiting for approval').first()).toBeVisible();
  });

  test('an approver checks the impact and publishes it', async ({ page }) => {
    await staffLogin(page, HQ, 'approver@medicare.test', '/platform');
    await expect(page.getByRole('heading', { name: 'Hospitals', exact: true })).toBeVisible();
    await page.locator(`a[href="${new URL(versionUrl).pathname}"]`).first().click();
    await expect(page).toHaveURL(versionUrl);
    await expect(page.getByText('A new plan: no hospital is on it yet.')).toBeVisible();
    await page.getByRole('form', { name: 'Approve' }).getByRole('button', { name: 'Approve and publish' }).click();
    await expect(page.locator('.mc-alert-success').first()).toContainText('Published.');
    await expect(page.getByText(/approved by approver@medicare\.test/)).toBeVisible();
  });

  test('support simulates and moves Greenleaf onto it; Greenleaf sees its new plan', async ({ page }) => {
    await staffLogin(page, HQ, 'support@medicare.test', '/platform');
    await page.getByRole('link', { name: 'greenleaf', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'greenleaf', exact: true })).toBeVisible();
    const plan = page.getByRole('form', { name: 'Simulate' }).getByLabel('Plan version');
    const value = await plan.locator('option', { hasText: 'Diagnostic Center – Professional v1' }).last().getAttribute('value');
    await plan.selectOption(value!);
    await page.getByRole('button', { name: 'Simulate' }).click();
    const sim = page.getByRole('region', { name: 'Simulation' });
    await expect(sim).toContainText('gains Diagnostics and lab');
    await expect(sim).toContainText('₹4,999 → ₹14,999/month');

    const move = page.getByRole('form', { name: 'Move to a plan' });
    await move.getByLabel('Plan').selectOption(CODE);
    await move.getByLabel('Reason').fill('Greenleaf adds a pathology lab (order form #88)');
    await move.getByRole('button', { name: 'Move now' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(`Moved to ${CODE}`);
    await expect(page.getByRole('heading', { name: 'greenleaf', exact: true })).toBeVisible();
    await expect(page.getByText('Diagnostic Center – Professional v1 since')).toBeVisible();

    await page.context().clearCookies();
    await staffLogin(page, GREEN, 'admin@greenleaf.test', '/admin/plan');
    await expect(page.getByText('Diagnostic Center – Professional · Diagnostic center')).toBeVisible();
    await expect(page.getByRole('row', { name: /^Diagnostics and lab / })).toContainText(/Active|Switching on/);
  });
});
