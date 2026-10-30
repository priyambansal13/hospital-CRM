import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { env, staffLogin } from './helpers';

// Phase 19 demo on Bright Smile Dental (account zone /account, dev billing clock):
//   a trial converts to paid → SMS beyond the allowance → the renewal is declined → past due → grace → suspended
//   (banner, read-only: records viewable, nothing new) → the owner pays with another card → active; the invoice shows
//   the SMS overage.
const PLATFORM = new URL('../..', import.meta.url).pathname;
const mc = (...args: string[]) => execFileSync('node', [join(PLATFORM, 'scripts/mc.mjs'), ...args], { encoding: 'utf8' });
const BS = 'http://brightsmile.localhost:3400';
const SUB = 'http://localhost:4413';
let tid = '';
const internal = (path: string, body: unknown = {}) => fetch(SUB + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_API_TOKEN }, body: JSON.stringify(body) }).then((r) => r.json());
const advance = (to: string) => internal(`/internal/tenants/${tid}/billing/advance`, { to });

test.describe.serial('SaaS billing: trial → paid → failed renewal → suspended → paid', () => {
  test.beforeAll(async () => {
    const list = () => JSON.parse(execFileSync('curl', ['-s', '-H', `x-internal-token: ${env.INTERNAL_API_TOKEN}`, 'http://localhost:4401/internal/tenants'], { encoding: 'utf8' })) as { id: string; slug: string }[];
    if (!list().some((t) => t.slug === 'brightsmile')) mc('tenant', 'create', 'brightsmile', '--name', 'Bright Smile Dental', '--admin', 'admin@brightsmile.test', '--plan', 'CLINIC_STARTER');
    tid = list().find((t) => t.slug === 'brightsmile')!.id;
    mc('plan', 'set', 'brightsmile', 'CLINIC_STARTER', '--reason', 'p19 e2e');
    await internal(`/internal/tenants/${tid}/billing/reset-trial`, { days: 14 });
    // a small SMS allowance so a few login codes go beyond it (support override; billed per SMS beyond it)
    const tok = await fetch('http://localhost:61180/realms/medicare/protocol/openid-connect/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: 'support@medicare.test', password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:medicare' }) }).then((r) => r.json());
    await fetch(`http://localhost:61000/api/subscription/v1/platform/hospitals/${tid}/features/core.sms`, { method: 'PUT', headers: { 'x-tenant-host': 'medicare.localhost', authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ value: { limit: 2 }, reason: 'p19 e2e: small SMS allowance' }) });
  });

  test.afterAll(async () => { await internal(`/internal/tenants/${tid}/billing/reset-trial`, { days: 14 }); });

  test('the owner adds a card during the trial; the trial converts to paid', async ({ page }) => {
    await staffLogin(page, BS, 'admin@brightsmile.test', '/account');
    await expect(page.getByRole('heading', { name: 'Subscription' })).toBeVisible();
    await expect(async () => {
      await page.goto(`${BS}/account`);
      await expect(page.getByRole('status', { name: 'Subscription' })).toContainText('Free trial until', { timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByText('free trial', { exact: true })).toBeVisible();
    // the card is entered on the payment gateway's page (simulated in dev), then the owner comes back (review B-6)
    await page.getByRole('form', { name: 'Card' }).getByRole('button', { name: /Add a card/ }).click();
    await expect(page.getByRole('heading', { name: 'Simulated gateway' })).toBeVisible();
    await page.getByLabel('Card number').fill('4111 1111 1111 1111');
    await page.getByLabel('Expiry (MM/YY)').fill('12/30');
    await page.getByLabel('Name on card').fill('Dr Smile');
    await page.getByRole('button', { name: 'Authorise card' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Visa ending 1111 saved for renewals');

    // three login codes for patients: beyond the 2 SMS included this month
    for (let i = 0; i < 3; i++) {
      await fetch('http://localhost:61000/api/iam/v1/auth/otp/request', { method: 'POST', headers: { 'x-tenant-host': 'brightsmile.localhost', 'content-type': 'application/json' }, body: JSON.stringify({ phone: `+9187${Date.now().toString().slice(-7)}${i}` }) });
    }
    await page.goto(`${BS}/account/usage`);
    await expect(page.getByRole('meter', { name: 'SMS messages used' })).toBeVisible();
    await expect(page.getByText(/^3 of 2 included/)).toBeVisible();

    await advance('trial-end');
    await page.goto(`${BS}/account`);
    await expect(page.getByText('active', { exact: true })).toBeVisible();
    await page.goto(`${BS}/account/invoices`);
    await expect(page.getByRole('row', { name: /first month/ })).toContainText('paid');
  });

  test('a declined renewal goes past due, then grace, then suspended: read only', async ({ page }) => {
    await staffLogin(page, BS, 'admin@brightsmile.test', '/account');
    await page.getByRole('form', { name: 'Card' }).getByRole('button', { name: /Change card/ }).click();
    await expect(page.getByRole('heading', { name: 'Simulated gateway' })).toBeVisible();
    await page.getByLabel('Card number').fill('4000 0000 0000 0002');
    await page.getByLabel('Expiry (MM/YY)').fill('11/29');
    await page.getByLabel('Name on card').fill('Dr Smile');
    await page.getByRole('button', { name: 'Authorise card' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('ending 0002 saved');

    await advance('period-end');
    await page.goto(`${BS}/account`);
    await expect(page.getByText('payment failed', { exact: true })).toBeVisible();
    // the banner follows the status event (entitlement-service) a moment after the subscription changes
    await expect(async () => {
      await page.goto(`${BS}/account`);
      await expect(page.getByRole('status', { name: 'Subscription' })).toContainText('The last payment to MediCare failed', { timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    for (let i = 0; i < 3; i++) await advance('next-retry');
    await expect(async () => {
      await page.goto(`${BS}/account`);
      await expect(page.getByRole('status', { name: 'Subscription' })).toContainText('Payment overdue: pay by', { timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await advance('grace-end');
    await expect(async () => {
      await page.goto(`${BS}/admin/plan`);
      await expect(page.getByRole('status', { name: 'Subscription' })).toContainText('Read only', { timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole('row', { name: /^Appointments / })).toContainText('Read only');
  });

  test('the owner pays with another card: active again; the invoice shows the SMS overage', async ({ page }) => {
    await staffLogin(page, BS, 'admin@brightsmile.test', '/account');
    await expect(page.getByText('suspended: read only', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Payment due' })).toBeVisible();
    await page.getByRole('form', { name: 'Card' }).getByRole('button', { name: /Change card/ }).click();
    await expect(page.getByRole('heading', { name: 'Simulated gateway' })).toBeVisible();
    await page.getByLabel('Card number').fill('5555 5555 5555 4444');
    await page.getByLabel('Expiry (MM/YY)').fill('09/31');
    await page.getByLabel('Name on card').fill('Dr Smile');
    await page.getByRole('button', { name: 'Authorise card' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('open invoices paid');
    await expect(page.getByText('active', { exact: true })).toBeVisible();

    await page.goto(`${BS}/account/invoices`);
    await page.getByRole('row', { name: /monthly/ }).first().getByRole('link').click();
    await expect(page.getByRole('heading', { name: /^Invoice MC-/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /SMS messages in .* beyond 2 included \(3 used\)/ })).toContainText('₹0.20');
    await expect(page.getByText(/GST 18%/)).toBeVisible();
  });
});
