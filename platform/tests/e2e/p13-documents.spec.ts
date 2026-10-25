import { expect, test } from '@playwright/test';
import { CITY, patientOtp, staffLogin, uniquePhone } from './helpers';

// Phase 13: a patient uploads an outside report from the browser straight to the hospital's storage; it is scanned
// and appears in the health timeline; they record an allergy and share the record with a doctor, who can then
// open the documents (and only for as long as it is shared); the patient sees that in the access log.
const phone = uniquePhone().replace('+9195', '+9191');
const who = `Arjun Upload ${phone.slice(-4)}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
let mrn = '';

test.describe.serial('documents and timeline', () => {
  test('patient uploads a report; it is scanned and appears in the timeline; downloads it', async ({ page }) => {
    await page.goto(`${CITY}/login?next=${encodeURIComponent('/care/profile')}`);
    await patientOtp(page, phone);
    await page.getByLabel('Full name').first().fill(who);
    await page.getByLabel('Date of birth').first().fill('1985-05-05');
    await page.getByRole('button', { name: 'Create my record' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(/Profile saved|saved/i);

    await page.goto(`${CITY}/care/timeline`);
    await expect(page.getByRole('heading', { name: 'Health record' })).toBeVisible();
    mrn = (await page.locator('.mc-page-header .mc-muted').textContent())!.match(/MRN\d+/)![0];
    const form = page.getByRole('form', { name: 'Upload a report' });
    await form.locator('input[type=file]').setInputFiles({ name: 'cbc.pdf', mimeType: 'application/pdf', buffer: PDF });
    await form.getByLabel('Title').fill('CBC from City Lab');
    await form.getByLabel('Date on the document').fill('2026-10-10');
    await form.getByRole('button', { name: 'Upload' }).click();
    await expect(form.getByRole('status')).toContainText('We are checking the file');
    const item = page.getByRole('list', { name: 'Timeline' }).getByRole('listitem').filter({ hasText: 'CBC from City Lab' });
    await expect(item).toBeVisible({ timeout: 20_000 }); // the page refreshes itself while the scan runs
    await expect(item).toContainText('uploaded by you');
    const res = await page.request.get(`${CITY}${await item.getByRole('link', { name: 'Download' }).getAttribute('href')}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toContain('attachment');
    expect(Buffer.from(await res.body()).equals(PDF)).toBe(true);

    await page.getByLabel('Allergic to').fill('Penicillin');
    await page.getByLabel('Severity').selectOption('SEVERE');
    await page.getByRole('button', { name: 'Add allergy' }).click();
    await expect(page.getByRole('list', { name: 'Allergies' })).toContainText('Penicillin');

    await page.getByRole('link', { name: 'Share with a doctor' }).click();
    await page.getByRole('combobox', { name: 'Doctor', exact: true }).selectOption({ label: 'Dr. Leak Test (General Medicine)' });
    await page.getByRole('combobox', { name: 'For', exact: true }).selectOption('7');
    await page.getByLabel("Doctors' visit notes").check();
    await page.getByRole('button', { name: 'Share' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Shared with Dr. Leak Test');
    await expect(page.getByRole('row').filter({ hasText: 'Dr. Leak Test' })).toContainText('Reports and documents');
  });

  test('the doctor it was shared with opens the record and the document; the patient sees it', async ({ browser }) => {
    const doc = await (await browser.newContext()).newPage();
    await staffLogin(doc, CITY, 'leak.doctor@citycare.test', '/doctor/patients');
    await doc.getByLabel('MRN').fill(mrn);
    await doc.getByRole('button', { name: 'Find' }).click();
    await doc.getByRole('link', { name: 'Open record' }).click();
    await expect(doc.locator('.mc-alert-info')).toContainText('Shared with you by the patient');
    await expect(doc.getByRole('list', { name: 'Allergies' })).toContainText('Penicillin');
    await expect(doc.locator('.mc-alert-error')).toContainText('Severe allergy: Penicillin');
    const row = doc.getByRole('row').filter({ hasText: 'CBC from City Lab' });
    const res = await doc.request.get(`${CITY}${await row.getByRole('link', { name: 'Download' }).getAttribute('href')}`);
    expect(res.status()).toBe(200);

    const pat = await (await browser.newContext()).newPage();
    await pat.goto(`${CITY}/login?next=${encodeURIComponent('/care/access-log')}`);
    await patientOtp(pat, phone);
    await expect(pat.getByRole('row').filter({ hasText: 'Dr. Leak Test' }).filter({ hasText: 'downloaded a document' })).toContainText('you shared it');

    await pat.goto(`${CITY}/care/sharing`);
    await pat.getByRole('row').filter({ hasText: 'Dr. Leak Test' }).getByRole('button', { name: 'Stop sharing' }).click();
    await expect(pat.locator('.mc-alert-success')).toContainText('Access removed');
    await expect(async () => {
      await doc.reload();
      await expect(doc.locator('.mc-alert-error').first()).toContainText('no appointment or visit', { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
  });
});
