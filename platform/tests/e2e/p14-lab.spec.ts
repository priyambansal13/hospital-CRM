import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CITY, patientOtp, staffLogin, uniquePhone } from './helpers';

// Phase 14: a patient books a Full Body Checkup at the lab; the lab technician sees it on the worklist, takes the
// payment, scans each tube's barcode and receives them at the bench.
const PLATFORM = new URL('../..', import.meta.url).pathname;
const psql = (sql: string) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
const phone = uniquePhone().replace('+9195', '+9186');
const who = `Nisha Lab ${phone.slice(-4)}`;
let orderNo = '';

test.describe.serial('lab', () => {
  test('patient books a Full Body Checkup and sees what to do before coming', async ({ page }) => {
    await page.goto(`${CITY}/care/tests`);
    const pkg = page.getByRole('generic', { name: 'Package Full Body Checkup' }).or(page.locator('label', { hasText: 'Full Body Checkup' }).first());
    await expect(pkg).toContainText('₹2999');
    await pkg.locator('input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Continue to booking' }).click();
    await patientOtp(page, phone);
    await page.getByLabel('Full name').first().fill(who);
    await page.getByLabel('Date of birth').first().fill('1982-02-02');
    await page.getByRole('button', { name: 'Create my record' }).click();
    await page.goto(`${CITY}/care/tests`);
    await page.locator('label', { hasText: 'Full Body Checkup' }).first().locator('input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Continue to booking' }).click();

    await expect(page.getByRole('heading', { name: 'Book lab tests' })).toBeVisible();
    await page.getByRole('navigation', { name: 'Days' }).getByRole('link').nth(1).click();
    await page.getByRole('radiogroup', { name: 'Times' }).getByRole('radio').first().check();
    await page.getByRole('radio', { name: 'Pay at the lab' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(/Booked LAB-\d{4}-\d{6}\. Pay at the lab\./);
    orderNo = (await page.locator('.mc-alert-success').textContent())!.match(/LAB-\d{4}-\d{6}/)![0];
    const card = page.getByRole('article', { name: `Lab order ${orderNo}` });
    await expect(card).toContainText('Booked');
    await expect(card).toContainText('Before you come: Fast for 10 hours');
  });

  test('lab technician takes payment, scans each tube and receives them', async ({ page }) => {
    psql(`UPDATE diagnostics.lab_orders SET slot_at = now() - interval '10 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE order_no = '${orderNo}'`);
    await staffLogin(page, CITY, 'lab@citycare.test', '/lab');
    await page.getByRole('link', { name: 'Sector 44' }).click();
    const card = page.getByRole('article', { name: `Lab order ${orderNo}` });
    await expect(card).toContainText(who);
    await expect(card).toContainText('₹2999 due');
    await expect(card.locator('svg').first()).toBeVisible(); // barcode labels
    const barcodes = await card.locator('tr[data-barcode]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-barcode')!));
    expect(barcodes).toHaveLength(4);

    await page.getByLabel('Barcode').fill(barcodes[0]);
    await page.getByRole('button', { name: 'Record' }).click();
    await expect(page.locator('.mc-alert-error')).toContainText('take the payment before collecting');

    const pay = page.getByRole('form', { name: `Collect payment for ${orderNo}` });
    await pay.getByLabel('Method').selectOption('CASH');
    await pay.getByRole('button', { name: 'Collect ₹2999' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('₹2999 received (cash)');

    for (const [i, b] of barcodes.entries()) {
      await page.getByLabel('Barcode').fill(b);
      await page.getByRole('button', { name: 'Record' }).click();
      await expect(page.locator('.mc-alert-success')).toContainText(i < 3 ? `${b} collected for ${who} — ${3 - i} more tube` : `${b} collected for ${who} — all tubes collected`);
    }
    await expect(page.getByRole('article', { name: `Lab order ${orderNo}` })).toContainText('collected');

    await page.getByLabel('Step').selectOption('receive');
    for (const b of barcodes) {
      await page.getByLabel('Barcode').fill(b);
      await page.getByLabel('Step').selectOption('receive');
      await page.getByRole('button', { name: 'Record' }).click();
      await expect(page.locator('.mc-alert-success')).toContainText(`${b} received at the lab`);
    }
    await expect(page.locator('.mc-alert-success')).toContainText(`${orderNo} is in the lab`);
    await expect(page.getByRole('article', { name: `Lab order ${orderNo}` })).toContainText('in lab');
  });
});
