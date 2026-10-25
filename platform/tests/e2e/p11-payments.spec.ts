import { expect, test } from '@playwright/test';
import { CITY, patientOtp, staffLogin, uniquePhone } from './helpers';

// Phase 11 (simulated Razorpay): a patient pays online (a declined attempt first), the appointment confirms and the
// receipt is in My bills; the front desk collects a walk-in's fee in cash; the admin refunds part of the online payment.
const phone = uniquePhone();
const who = `Riya Payer ${phone.slice(-4)}`;
const walkin = `Kabir Cash ${phone.slice(-4)}`;
let invoiceNo = '';

test.describe.serial('payments', () => {
  test('patient pays online; a declined attempt can be retried; confirmed; receipt in My bills', async ({ page }) => {
    await page.goto(`${CITY}/care/doctors?q=asha`);
    await page.getByRole('link', { name: 'Dr. Asha Rao' }).click();
    await page.getByRole('navigation', { name: 'Dates' }).getByRole('link').nth(6).click();
    await page.locator('.mc-time').last().click();
    await patientOtp(page, phone);
    await page.getByLabel('Full name').fill(who);
    await page.getByLabel('Date of birth').fill('1990-07-07');
    await page.getByRole('button', { name: 'Save and continue' }).click();

    await expect(page.getByRole('radio', { name: /Pay ₹1,000 now/ })).toBeChecked();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Pay to confirm your appointment' })).toBeVisible();
    await expect(page.getByText(/We are holding this time for you until/)).toBeVisible();

    await page.getByRole('button', { name: 'Simulate a declined payment' }).click();
    await expect(page.locator('.mc-alert-error').first()).toContainText('declined by the bank');
    await page.getByLabel('Pay with (test payment)').selectOption('card');
    await page.getByRole('button', { name: 'Pay ₹1,000' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(/Paid ₹1,000\. Your appointment APT-\d{4}-\d{6} is confirmed\./, { timeout: 20_000 });

    const pdf = await page.request.get(await page.getByRole('link', { name: 'Download receipt (PDF)' }).getAttribute('href').then((h) => `${CITY}${h}`));
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

    await page.goto(`${CITY}/care/appointments`);
    const card = page.getByRole('region', { name: 'Upcoming' }).getByRole('article').filter({ hasText: `For ${who}` }).first();
    await expect(card).toContainText('Confirmed');
    await expect(card).toContainText('₹1000 paid');

    await page.goto(`${CITY}/care/bills`);
    const row = page.getByRole('row').filter({ hasText: who });
    await expect(row).toContainText('Paid');
    invoiceNo = (await row.getByTestId(/bill-/).textContent())!.trim();
    expect(invoiceNo).toMatch(/^INV-\d{4}-\d{6}$/);
  });

  test('front desk collects a walk-in’s fee in cash', async ({ page }) => {
    await staffLogin(page, CITY, 'desk@citycare.test', '/desk');
    await page.getByRole('link', { name: 'Sector 44' }).click();
    await page.getByRole('link', { name: 'New walk-in' }).click();
    const p = uniquePhone().replace('+9195', '+9193');
    await page.getByLabel('Mobile, MRN or name').fill(p);
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByLabel('Full name').fill(walkin);
    await page.getByLabel('Date of birth').fill('1979-03-03');
    await page.getByRole('button', { name: 'Register and book' }).click();
    await page.getByRole('link', { name: /Dr\. Asha Rao · \d+ waiting/ }).click();
    await page.getByRole('radio', { name: /Join the queue now/ }).check();
    await page.getByRole('button', { name: 'Book' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(`${walkin} checked in`);

    const row = page.getByRole('row').filter({ hasText: walkin });
    const collect = row.getByRole('form', { name: `Collect payment for ${walkin}` });
    await expect(collect).toBeVisible({ timeout: 15_000 }); // invoice is created from the booking event
    await collect.getByLabel('Method').selectOption('CASH');
    await collect.getByRole('button', { name: /Collect ₹1000/ }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(new RegExp(`₹1000 received \\(cash\\) for ${walkin} — INV-`));
    await expect(page.getByRole('row').filter({ hasText: walkin })).toContainText('paid');
  });

  test('admin sees the day’s collections and refunds part of the online payment', async ({ page }) => {
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/billing');
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
    await expect(page.getByText('Collected online')).toBeVisible();
    await page.getByLabel('Invoice no., patient or MRN').fill(invoiceNo);
    await page.getByRole('button', { name: 'Show' }).click();
    await page.getByRole('link', { name: invoiceNo }).click();
    await expect(page.getByRole('heading', { name: invoiceNo })).toBeVisible();
    await page.getByLabel(/Amount \(up to ₹1,000\)/).fill('200');
    await page.getByLabel('Reason').fill('Goodwill: long wait');
    await page.getByRole('button', { name: 'Refund' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Refund of ₹200 started');
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole('row').filter({ hasText: 'Goodwill: long wait' })).toContainText('processed', { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.locator('.mc-summary')).toContainText('partially refunded');
  });
});
