import { expect, test } from '@playwright/test';
import { env, patientOtp, staffLogin, uniquePhone } from './helpers';

// Phase 20 demo: a new clinic signs up on MediCare's site, confirms its e-mail, watches its hospital being set up,
// completes the setup guide (branding, branch, doctor, hours, bank account), a patient books the first appointment,
// and the owner creates a custom role. The test hospital is deleted at the end.
const SITE = 'http://medicare.localhost:3400';
const SLUG = `neem${Date.now().toString().slice(-6)}`;
const HOSP = `http://${SLUG}.localhost:3400`;
const OWNER = `owner.${SLUG}@example.test`;
const started = Date.now();

async function link(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const s = await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${OWNER}`)}`).then((r) => r.json());
    if (s.messages?.[0]) {
      const m = await fetch(`http://localhost:61825/api/v1/message/${s.messages[0].ID}`).then((r) => r.json());
      return /(http:\/\/\S+\/signup\/verify\?token=[A-Za-z0-9_-]+)/.exec(m.Text)![1];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no signup e-mail');
}

test.describe.serial('self-serve onboarding', () => {
  test.afterAll(async () => {
    const tenants = await fetch('http://localhost:4401/internal/tenants', { headers: { 'x-internal-token': env.INTERNAL_API_TOKEN } }).then((r) => r.json()) as { id: string; slug: string }[];
    const t = tenants.find((x) => x.slug === SLUG);
    if (t) await fetch(`http://localhost:4401/internal/tenants/${t.id}/status`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_API_TOKEN }, body: JSON.stringify({ status: 'DELETED' }) });
  });

  test('a clinic signs up on the pricing page and its hospital is set up', async ({ page }) => {
    await page.goto(`${SITE}/`);
    await page.getByRole('link', { name: 'Plans and prices' }).click();
    await expect(page.getByRole('heading', { name: 'Plans and prices' })).toBeVisible();
    await page.getByRole('link', { name: 'Start a free trial of Clinic Professional' }).click();
    const form = page.getByRole('form', { name: 'Sign up' });
    await form.getByLabel('Hospital or clinic name').fill('Neem Tree Clinic');
    await form.getByLabel('Web address').fill(SLUG);
    await form.getByLabel('Your name').fill('Dr Nisha Neem');
    await form.getByLabel('Work e-mail').fill(OWNER);
    await expect(form.getByLabel('Plan')).toHaveValue('CLINIC_PRO');
    await form.getByRole('button', { name: 'Create my hospital' }).click();
    await expect(page.getByRole('heading', { name: 'Check your e-mail' })).toBeVisible();

    await page.goto(await link());
    await expect(page.getByRole('heading', { name: 'Neem Tree Clinic is ready' })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('list', { name: 'Setup steps' }).getByRole('listitem')).toHaveCount(5);
    await expect(page.getByRole('link', { name: 'Sign in to Neem Tree Clinic' })).toHaveAttribute('href', `${HOSP}/login?next=%2Fadmin%2Fsetup`);
  });

  test('the owner completes the setup guide', async ({ page }) => {
    await staffLogin(page, HOSP, OWNER, '/admin/setup');
    await expect(page.getByRole('heading', { name: 'Set up your hospital' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Subscription' })).toContainText('Free trial until');

    const b = page.getByRole('form', { name: 'Branding' });
    await b.getByLabel('Name patients see').fill('Neem Tree Clinic');
    await b.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Branding saved');

    const br = page.getByRole('form', { name: 'Branch' });
    await br.getByLabel('Branch name').fill('Baner');
    await br.getByLabel('City').fill('Pune');
    await br.getByLabel('Address').fill('Baner Road 21');
    await br.getByRole('button', { name: 'Add branch' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Branch Baner added');

    // the branch reaches the doctor directory a moment later
    await expect(async () => {
      await page.goto(`${HOSP}/admin/setup?step=doctor`);
      await expect(page.getByRole('form', { name: 'Doctor' }).getByLabel('Branch')).toContainText('Baner', { timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    const d = page.getByRole('form', { name: 'Doctor' });
    await d.getByLabel("Doctor's name").fill('Dr. Kavita Rao');
    await d.getByLabel("Doctor's e-mail").fill(`kavita.${SLUG}@example.test`);
    await d.getByLabel('Registration number').fill(`MMC/${SLUG}`);
    await d.getByRole('button', { name: 'Add and publish' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Dr. Kavita Rao added and published');

    await expect(async () => {
      await page.goto(`${HOSP}/admin/setup?step=hours`);
      await expect(page.getByRole('form', { name: 'Hours' })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    const h = page.getByRole('form', { name: 'Hours' });
    await h.getByRole('checkbox', { name: 'Sun' }).check();
    await h.getByLabel('From').fill('07:00');
    await h.getByLabel('To').fill('21:00');
    await h.getByRole('button', { name: 'Save hours' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('patients can book now');

    const p = page.getByRole('form', { name: 'Payments' });
    await p.getByLabel('PAN', { exact: true }).fill('ABCDE1234F');
    await p.getByLabel('Bank account number').fill('50100123456789');
    await p.getByLabel('IFSC').fill('HDFC0001234');
    await p.getByLabel('E-mail for payouts').fill(OWNER);
    await p.getByRole('button', { name: 'Connect bank account' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Bank account connected');
    await expect(page.getByText('Your patients book at')).toBeVisible();
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page.getByRole('heading', { name: 'All set' })).toBeVisible();
  });

  test('the first patient books and pays online, well within 30 minutes of signing up', async ({ page }) => {
    await page.goto(`${HOSP}/care/doctors?q=kavita`);
    await page.getByRole('link', { name: 'Dr. Kavita Rao' }).click();
    await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible();
    await page.getByRole('navigation', { name: 'Dates' }).getByRole('link').nth(1).click();
    await page.locator('.mc-time').first().click();
    await patientOtp(page, uniquePhone());
    await page.getByLabel('Full name').fill('Asha First');
    await page.getByLabel('Date of birth').fill('1990-05-05');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    // the clinic connected its bank account in the setup guide: patients pay online (₹500 consultation)
    await expect(page.getByRole('radio', { name: /Pay ₹500 now/ })).toBeChecked();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Pay to confirm your appointment' })).toBeVisible();
    await page.getByRole('button', { name: 'Pay ₹500' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(/Paid ₹500\. Your appointment APT-\d{4}-\d{6} is confirmed\./, { timeout: 20_000 });
    expect(Date.now() - started).toBeLessThan(30 * 60_000);
  });

  test('the owner creates a custom role and previews it', async ({ page }) => {
    await staffLogin(page, HOSP, OWNER, '/admin/roles');
    const f = page.getByRole('form', { name: 'New role' });
    await f.getByLabel('Name').fill('Senior nurse');
    await f.getByLabel('Code').fill('SENIOR_NURSE');
    await f.getByLabel('Start from').selectOption('NURSE');
    await f.getByRole('button', { name: 'Create role' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Role Senior nurse created');
    const perms = page.getByRole('form', { name: 'Permissions' });
    await perms.getByRole('checkbox', { name: 'View all appointments in the branch' }).check();
    await perms.getByRole('button', { name: 'Save permissions' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Permissions saved');
    await expect(page.getByText('Preview: someone with only "Senior nurse"')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Changes' })).toBeVisible();
    await expect(page.getByRole('row', { name: /SENIOR_NURSE/ }).first()).toContainText(OWNER);
  });
});
