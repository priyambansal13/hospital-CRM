import { expect, test } from '@playwright/test';
import { stamp, staffLogin } from './helpers';

// SEO and ads (docs/SEO-AND-ADS.md): a visitor arrives from an ad, accepts ad cookies and asks for a demo → MediCare
// support sees the request with its campaign on the console's Growth page → a hospital admin uses Search and ads:
// profile checks, a campaign link, the Google Business Profile checklist.
const HQ = 'http://medicare.localhost:3400';
const AAROGYA = 'http://aarogya.localhost:3400';
const SHOTS = process.env.SHOTS_DIR;
const S = stamp();

test('a visitor from an ad asks for a demo; support sees it with its campaign', async ({ browser }) => {
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  await page.goto(`${HQ}/for/clinics?utm_source=google&utm_medium=cpc&utm_campaign=e2e-${S}&gclid=E2E${S}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Clinic management software');
  // consent before any ad cookie; the click id is kept once accepted
  await page.getByRole('button', { name: 'Accept ad cookies' }).click();
  const attr = (await visitor.cookies()).find((c) => c.name === 'mc_attr');
  expect(decodeURIComponent(attr?.value ?? '')).toContain(`E2E${S}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/p30-segment.png` });
  await page.getByRole('link', { name: 'Book a demo' }).first().click();
  await page.getByLabel('Your name').fill('Dr E2E Demo');
  await page.getByLabel('Work e-mail').fill(`e2e.${S}@example.test`);
  await page.getByLabel('Hospital or clinic').fill(`E2E Clinic ${S}`);
  await page.getByLabel('City').fill('Jaipur');
  await page.getByRole('button', { name: 'Request a demo' }).click();
  await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  await visitor.close();

  const staff = await browser.newPage();
  await staffLogin(staff, HQ, 'support@medicare.test', '/platform/growth');
  await expect(staff.getByRole('heading', { name: 'Growth' })).toBeVisible({ timeout: 30000 });
  const row = staff.getByRole('row').filter({ hasText: `E2E Clinic ${S}` });
  await expect(row).toContainText(`google / e2e-${S}`);
  await expect(row).toContainText('/for/clinics');
  await row.getByLabel('Note').fill('Called');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(staff.getByText('Demo request updated')).toBeVisible();
  if (SHOTS) await staff.screenshot({ path: `${SHOTS}/p30-growth.png`, fullPage: true });
});

test('a hospital admin uses Search and ads', async ({ page }) => {
  await staffLogin(page, AAROGYA, 'admin@aarogya.test', '/admin/seo');
  await expect(page.getByRole('heading', { name: 'Search and ads' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Doctors' profiles")).toBeVisible();
  await expect(page.getByText('no photo').first()).toBeVisible();
  await page.getByLabel('Where you will share it').fill('poster');
  await page.getByLabel('Campaign name').fill(`opd-${S}`);
  await page.getByRole('button', { name: 'Make the link' }).click();
  await expect(page.getByText(`${AAROGYA}/?utm_source=poster&utm_campaign=opd-${S}`)).toBeVisible();
  await expect(page.getByText('utm_source=google-business&utm_campaign=noida-sector-62')).toBeVisible();
  await expect(page.getByText('Drugs and Magic Remedies')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/p30-admin-seo.png`, fullPage: true });
});
