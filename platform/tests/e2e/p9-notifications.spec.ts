import { expect, test } from '@playwright/test';
import { CITY, patientOtp, staffLogin, uniquePhone, confirmPayAtHospital } from './helpers';

// Phase 9: booking sends a confirmation (SMS + email, in the patient's language); admins see the delivery log with
// contact details masked, and can edit templates.
const phone = uniquePhone().replace('+9195', '+9191');
const email = `e2e.${phone.slice(-6)}@example.test`;
const mailpit = async (q: string) => (await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages ?? [];

test.describe.serial('notifications', () => {
  test('patient sets message preferences, books, and gets the confirmation by SMS and email', async ({ page }) => {
    await page.goto(`${CITY}/login?next=${encodeURIComponent('/care/profile')}`);
    await patientOtp(page, phone);
    await page.getByLabel('Full name').first().fill('Arjun Nair');
    await page.getByLabel('Date of birth').first().fill('1987-11-11');
    await page.getByLabel('Email (optional)').fill(email);
    await page.getByRole('button', { name: 'Create my record' }).click();
    await expect(page.getByRole('status')).toContainText('Profile saved');
    await expect(page.getByText(`Email to ${email}`)).toBeVisible();
    await page.getByLabel('Language').selectOption('hi');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByRole('status')).toContainText('Message preferences saved');

    await page.goto(`${CITY}/care/doctors?q=asha`);
    await page.getByRole('link', { name: 'Dr. Asha Rao' }).click();
    await page.getByRole('navigation', { name: 'Dates' }).getByRole('link').nth(5).click();
    await page.locator('.mc-time').first().click();
    await confirmPayAtHospital(page);
    const no = (await page.getByRole('status').textContent())!.match(/APT-\d{4}-\d{6}/)![0];

    await expect.poll(async () => (await mailpit(`to:${phone.slice(1)}@sms.medicare.local`)).map((m: any) => m.Snippet).find((t: string) => t.includes(no)) ?? '', { timeout: 20_000 }).toContain('पक्की');
    await expect.poll(async () => (await mailpit(`to:${email}`)).map((m: any) => m.Subject).join('|'), { timeout: 20_000 }).toContain('Appointment confirmed');
  });

  test('admin sees the delivery log (masked) and edits a template', async ({ page }) => {
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/messages');
    await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
    const row = page.getByRole('row', { name: /Booking confirmed SMS Arjun Nair/ }).first();
    await expect(row).toContainText('sent');
    await expect(row).toContainText(`+91******${phone.slice(-4)}`);
    await expect(page.getByRole('row', { name: /Reminder, 24 hours .*Arjun Nair/ }).first()).toContainText('scheduled');

    await page.getByRole('link', { name: 'Templates' }).click();
    await expect(page.getByRole('heading', { name: 'Booking confirmed · SMS · English' })).toBeVisible();
    const form = page.locator('section', { has: page.getByRole('heading', { name: 'Reminder, 2 hours · SMS · English' }) });
    const text = form.locator('textarea[name=body]');
    // let the page finish loading first: typing before React has taken over the form can mix old and new text
    await page.waitForLoadState('networkidle');
    const original = await text.inputValue();
    await text.fill(`${original} Bring old reports.`);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Template saved');
    const again = page.locator('section', { has: page.getByRole('heading', { name: 'Reminder, 2 hours · SMS · English' }) }).locator('textarea[name=body]');
    await expect(again).toHaveValue(`${original} Bring old reports.`);
    await again.fill(original);
    await page.locator('section', { has: page.getByRole('heading', { name: 'Reminder, 2 hours · SMS · English' }) }).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Template saved');
  });
});
