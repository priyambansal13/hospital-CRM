import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CITY, env, patientOtp, staffLogin, uniquePhone } from './helpers';

// Phase 16: a patient books a fasting sugar test at home → the lab assigns Ravi (phlebotomist) → Ravi sets off,
// arrives, takes the payment, scans the tube → the patient sees "samples collected" → the lab's scan is the hand-over.
const PLATFORM = new URL('../..', import.meta.url).pathname;
const psql = (sql: string) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
const G = 'http://localhost:61000';
async function call(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': 'citycare.localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
async function staffToken(email: string) {
  const r = await fetch('http://localhost:61180/realms/medicare/protocol/openid-connect/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:citycare' }) });
  return ((await r.json()) as { access_token: string }).access_token;
}

const phone = uniquePhone().replace('+9195', '+9182');
const who = `Kavya Home ${phone.slice(-4)}`;
let orderNo = '';
let visitDate = '';

test.describe.serial('home collection', () => {
  test.beforeAll(async () => {
    // the hospital collects at home in 122003 (Sector 44, ₹100); Ravi Kumar is a phlebotomist
    const admin = await staffToken('admin@citycare.test');
    const branch = (await (await fetch(`${G}/api/diagnostics/v1/public/lab-branches`, { headers: { 'x-tenant-host': 'citycare.localhost' } })).json() as any[]).find((b) => b.name === 'Sector 44');
    await call('POST', '/api/diagnostics/v1/admin/home-areas', admin, { pincode: '122003', branchId: branch.id, area: 'Sector 44, Gurugram', fee: 100 });
    await call('POST', '/api/iam/v1/staff/invites', admin, { email: 'ravi.phleb@citycare.test', name: 'Ravi Kumar', roles: ['PHLEBOTOMIST'] });
    await call('POST', '/api/iam/v1/staff/invites', admin, { email: 'lab@citycare.test', name: 'Lata Lab', roles: ['LAB_TECH'] });
  });

  test('patient books a fasting sugar test at home', async ({ page }) => {
    await page.goto(`${CITY}/care/tests?q=fasting`);
    await page.getByRole('checkbox', { name: 'Fasting Blood Sugar' }).check();
    await page.getByRole('button', { name: 'Continue to booking' }).click();
    await patientOtp(page, phone);
    await page.getByLabel('Full name').first().fill(who);
    await page.getByLabel('Date of birth').first().fill('1979-07-07');
    await page.getByRole('button', { name: 'Create my record' }).click();
    await page.goto(`${CITY}/care/tests?q=fasting`);
    await page.getByRole('checkbox', { name: 'Fasting Blood Sugar' }).check();
    await page.getByRole('button', { name: 'Continue to booking' }).click();

    await page.getByRole('navigation', { name: 'Where' }).getByRole('link', { name: 'At home' }).click();
    await page.getByLabel('Pincode').fill('110001');
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('.mc-alert-error')).toContainText('We do not collect samples at home in 110001');
    await page.getByLabel('Pincode').fill('122003');
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByText('We collect at home in 122003 (Sector 44, Gurugram): ₹100 visit fee')).toBeVisible();
    await page.getByRole('navigation', { name: 'Days' }).getByRole('link').nth(1).click();
    await page.getByLabel('House / flat, street').fill('Flat 302, Tower B');
    await page.getByLabel('Landmark').fill('opposite the school');
    await page.getByLabel('City').fill('Gurugram');
    await page.getByLabel('Phone for the collector').fill(phone);
    await page.getByRole('radiogroup', { name: 'Times' }).getByRole('radio').first().check();
    const collector = page.getByRole('radio', { name: 'Pay the collector at home' });
    if (await collector.count()) await collector.check();
    await page.getByRole('button', { name: /^(Book|Continue)$/ }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(/Booked LAB-\d{4}-\d{6}: sample collection at home/);
    orderNo = (await page.locator('.mc-alert-success').textContent())!.match(/LAB-\d{4}-\d{6}/)![0];
    const card = page.getByRole('article', { name: `Lab order ${orderNo}` });
    await expect(card).toContainText('Flat 302, Tower B, opposite the school, 122003');
    await expect(card).toContainText('We will tell you who is coming');
    await expect(card).toContainText('to pay the collector');
    visitDate = psql(`SELECT local_date FROM diagnostics.lab_orders WHERE order_no = '${orderNo}'`);
  });

  test('the lab assigns Ravi; the patient sees who is coming', async ({ page, browser }) => {
    await staffLogin(page, CITY, 'lab@citycare.test', `/lab/home?date=${visitDate}`);
    await expect(page.getByRole('heading', { name: 'Home collections' })).toBeVisible();
    const assign = page.getByRole('form', { name: `Assign ${orderNo}` });
    const ravi = await assign.getByLabel('Phlebotomist').locator('option', { hasText: 'Ravi Kumar' }).getAttribute('value');
    await assign.getByLabel('Phlebotomist').selectOption(ravi!);
    await assign.getByRole('button', { name: 'Assign' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(`${orderNo}`);
    await expect(page.locator('.mc-alert-success')).toContainText('assigned to Ravi Kumar');
    await expect(page.getByRole('row', { name: new RegExp(who) })).toContainText('assigned');

    const patient = await (await browser.newContext()).newPage();
    await patient.goto(`${CITY}/login?next=${encodeURIComponent('/care/lab-orders')}`);
    await patientOtp(patient, phone);
    await expect(patient.getByRole('article', { name: `Lab order ${orderNo}` })).toContainText('Ravi Kumar is coming');
  });

  test('Ravi collects at home and the lab receives the tube', async ({ page }) => {
    // the visit is today
    const id = psql(`SELECT id FROM diagnostics.lab_orders WHERE order_no = '${orderNo}'`);
    psql(`UPDATE diagnostics.lab_orders SET slot_at = now() + interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id = '${id}';
          UPDATE diagnostics.home_visits SET slot_at = now() + interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE order_id = '${id}'`);
    await staffLogin(page, CITY, 'ravi.phleb@citycare.test', '/lab/visits');
    await expect(page.getByRole('heading', { name: 'My visits' })).toBeVisible();
    const card = page.getByRole('article', { name: `Visit ${orderNo}` });
    await expect(card).toContainText('Flat 302, Tower B');
    await expect(card).toContainText('Fast for');
    await card.getByRole('button', { name: 'On my way' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('On your way');
    await page.getByRole('article', { name: `Visit ${orderNo}` }).getByRole('button', { name: 'Arrived' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Arrived');
    const pay = page.getByRole('form', { name: `Payment for ${orderNo}` });
    await pay.getByLabel('Method').selectOption('UPI');
    await pay.getByLabel('Reference').fill('UPI778899');
    await pay.getByRole('button', { name: /Take ₹\d+/ }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('received (upi)');
    const barcode = await page.getByRole('article', { name: `Visit ${orderNo}` }).locator('tr[data-barcode]').first().getAttribute('data-barcode');
    await page.getByRole('form', { name: `Collect for ${orderNo}` }).getByLabel('Tube barcode').fill(barcode!);
    await page.getByRole('button', { name: 'Collected' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(`${barcode} collected — all tubes collected`);
    await expect(page.getByRole('article', { name: `Visit ${orderNo}` })).toContainText('Take the tubes to the Sector 44 lab');

    await page.context().clearCookies();
    await staffLogin(page, CITY, 'lab@citycare.test', '/lab');
    await page.getByLabel('Barcode').fill(barcode!);
    await page.getByLabel('Step').selectOption('receive');
    await page.getByRole('button', { name: 'Record' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(`${orderNo} is in the lab`);
    await page.goto(`${CITY}/lab/home`);
    await expect(page.getByRole('row', { name: new RegExp(who) })).toContainText('at the lab');
  });
});
