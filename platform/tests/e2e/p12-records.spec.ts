import { expect, type Page, test } from '@playwright/test';
import { CITY, patientOtp, staffLogin, uniquePhone } from './helpers';

// Phase 12: the doctor writes a visit (vitals, notes, ICD-10 diagnosis), signs it and issues a prescription; the
// patient sees the prescription (PDF) and who opened their record; another doctor is refused, uses break-glass;
// the admin sees it in the audit log and the chain verifies.
const phone = uniquePhone().replace('+9195', '+9192');
const who = `Leela Rx ${phone.slice(-4)}`;
let mrn = '';

async function walkIn(desk: Page) {
  await staffLogin(desk, CITY, 'desk@citycare.test', '/desk');
  await desk.getByRole('link', { name: 'Sector 44' }).click();
  await desk.getByRole('link', { name: 'New walk-in' }).click();
  await desk.getByLabel('Mobile, MRN or name').fill(phone);
  await desk.getByRole('button', { name: 'Search' }).click();
  await desk.getByLabel('Full name').fill(who);
  await desk.getByLabel('Date of birth').fill('1966-06-16');
  await desk.getByLabel('Gender').selectOption('FEMALE');
  await desk.getByRole('button', { name: 'Register and book' }).click();
  await expect(desk.getByRole('heading', { name: `Book a visit for ${who}` })).toBeVisible();
  mrn = (await desk.locator('.mc-page-header .mc-muted').textContent())!.match(/MRN\d+/)![0];
  await desk.getByRole('link', { name: /Dr\. Asha Rao · \d+ waiting/ }).click();
  await desk.getByRole('radio', { name: /Join the queue now/ }).check();
  await desk.getByLabel('Reason for visit (optional)').fill('Thirst, tired');
  await desk.getByRole('button', { name: 'Book' }).click();
  await expect(desk.locator('.mc-alert-success')).toContainText(`${who} checked in`);
}

test.describe.serial('clinical records', () => {
  test('doctor writes the visit, signs it and prescribes', async ({ browser }) => {
    await walkIn(await (await browser.newContext()).newPage());
    const doc = await (await browser.newContext()).newPage();
    await staffLogin(doc, CITY, 'asha.rao@citycare.test', '/doctor/queue');
    const row = doc.getByRole('listitem').filter({ hasText: who });
    await row.getByRole('button', { name: /Call in|Start/ }).click();
    await doc.getByRole('listitem').filter({ hasText: who }).getByRole('link', { name: 'Open visit' }).click();
    await doc.getByRole('button', { name: 'Start visit' }).click();
    await expect(doc.locator('.mc-alert-success')).toContainText('Visit started');
    await expect(doc.getByRole('heading', { name: who })).toBeVisible();

    await doc.getByLabel('BP (mmHg)').fill('142/90');
    await doc.getByLabel('Pulse (/min)').fill('88');
    await doc.getByLabel('Chief complaint').fill('Excessive thirst for 3 weeks');
    await doc.getByLabel('Clinical notes').fill('Random glucose 298 mg/dL. Start metformin, review in 4 weeks.');
    await doc.getByRole('button', { name: 'Save draft' }).click();
    await expect(doc.locator('.mc-alert-success')).toContainText('Saved');
    await expect(doc.getByLabel('Clinical notes')).toHaveValue(/Random glucose 298/);

    await doc.getByLabel('Search ICD-10').fill('diabetes');
    await doc.getByRole('button', { name: 'Search' }).click();
    await doc.getByRole('button', { name: 'Add E11.9' }).click();
    await expect(doc.getByRole('list', { name: 'Diagnoses' })).toContainText('Type 2 diabetes mellitus without complications');
    await doc.getByRole('button', { name: 'Sign visit' }).click();
    await expect(doc.locator('.mc-alert-success')).toContainText('Visit signed');
    await expect(doc.getByRole('heading', { name: 'Amend' })).toBeVisible();

    await doc.getByLabel('Medicine 1').fill('Metformin');
    await doc.getByLabel('Strength 1').fill('500 mg');
    await doc.getByLabel('Form 1').fill('tablet');
    await doc.getByLabel('Dosage 1').fill('1-0-1');
    await doc.getByLabel('Days 1').fill('30');
    await doc.getByLabel('Instructions 1').fill('after food');
    await doc.getByLabel('Advice').fill('Walk 30 minutes a day.');
    await doc.getByRole('button', { name: 'Issue prescription' }).click();
    await expect(doc.locator('.mc-alert-success')).toContainText('Prescription issued');
    await expect(doc.getByText(/RX-\d{4}-\d{6}: Metformin 500 mg 1-0-1 × 30d/)).toBeVisible();
    await doc.getByRole('button', { name: 'Finish visit' }).click();
    await expect(doc.locator('.mc-alert-success')).toContainText('Visit completed');
  });

  test('patient sees the prescription and who opened the record', async ({ page }) => {
    await page.goto(`${CITY}/login?next=${encodeURIComponent('/care/prescriptions')}`);
    await patientOtp(page, phone);
    const rx = page.getByRole('article').filter({ hasText: who });
    await expect(rx).toContainText('Metformin 500 mg');
    await expect(rx).toContainText('Type 2 diabetes mellitus');
    const pdf = await page.request.get(`${CITY}${await rx.getByRole('link', { name: 'Download PDF' }).getAttribute('href')}`);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    await page.goto(`${CITY}/care/access-log`);
    await expect(page.getByRole('row').filter({ hasText: 'Dr. Asha Rao' }).first()).toContainText('treating doctor');
  });

  test('another doctor is refused, uses break-glass; the patient and the admin see it', async ({ browser }) => {
    const doc = await (await browser.newContext()).newPage();
    await staffLogin(doc, CITY, 'leak.doctor@citycare.test', '/doctor/patients');
    await doc.getByLabel('MRN').fill(mrn);
    await doc.getByRole('button', { name: 'Find' }).click();
    await expect(doc.getByText('You have no appointment or visit with this patient')).toBeVisible();
    await doc.getByRole('link', { name: 'Open record' }).click();
    await expect(doc.locator('.mc-alert-error')).toContainText('no appointment or visit with this patient');
    await doc.getByLabel('Reason').fill('Collapsed in the waiting area; need medication history');
    await doc.getByRole('button', { name: 'Open with emergency access' }).click();
    await expect(doc.locator('.mc-alert-error')).toContainText('Emergency access until');
    await expect(doc.getByText('Random glucose 298')).toBeVisible();

    const pat = await (await browser.newContext()).newPage();
    await pat.goto(`${CITY}/login?next=${encodeURIComponent('/care/access-log')}`);
    await patientOtp(pat, phone);
    await expect(pat.locator('.mc-alert-error')).toContainText('Dr. Leak Test used emergency access');

    const admin = await (await browser.newContext()).newPage();
    await staffLogin(admin, CITY, 'admin@citycare.test', '/admin/audit');
    await admin.getByLabel('Patient MRN').fill(mrn);
    await admin.getByRole('button', { name: 'Filter' }).click();
    await expect(admin.getByRole('row').filter({ hasText: 'Dr. Leak Test' }).filter({ hasText: 'break-glass' }).first()).toBeVisible();
    await expect(admin.getByRole('row').filter({ hasText: 'Dr. Asha Rao' }).filter({ hasText: 'sign' }).first()).toBeVisible();
    await admin.getByRole('link', { name: 'Verify the chain' }).click();
    await expect(admin.locator('.mc-alert-success')).toContainText('Audit chain intact');
  });
});
