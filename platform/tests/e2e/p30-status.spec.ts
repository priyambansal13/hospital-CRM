import { expect, test } from '@playwright/test';
import { CITY, stamp, staffLogin } from './helpers';

// Phase 30 part 2: MediCare support posts an incident on the console's Status page → it shows on the public /status
// page and as a banner on a hospital admin's pages → support resolves it and both clear.
const HQ = 'http://medicare.localhost:3400';
const SHOTS = process.env.SHOTS_DIR;
const S = stamp();
const TITLE = `Online payment is failing (e2e ${S})`;

test('an incident from the console reaches the status page and hospitals, then is resolved', async ({ browser }) => {
  const support = await browser.newPage();
  await staffLogin(support, HQ, 'support@medicare.test', '/platform/status');
  await expect(support.getByRole('heading', { name: 'Status page' })).toBeVisible({ timeout: 30000 });
  const form = support.getByRole('form', { name: 'New incident' });
  await form.getByLabel('Title (public)').fill(TITLE);
  await form.getByLabel('Impact').selectOption('MAJOR');
  await form.getByLabel('Payments and billing').check();
  await form.getByLabel(/First message/).fill('Choose pay at the hospital; your booking is kept.');
  await form.getByRole('button', { name: 'Post' }).click();
  await expect(support.getByText('Posted on the status page')).toBeVisible();
  if (SHOTS) await support.screenshot({ path: `${SHOTS}/p30-status-console.png`, fullPage: true });

  const visitor = await browser.newPage();
  await visitor.goto(`${HQ}/status`);
  await expect(visitor.getByText(TITLE)).toBeVisible();
  await expect(visitor.getByText('Choose pay at the hospital; your booking is kept.')).toBeVisible();
  if (SHOTS) await visitor.screenshot({ path: `${SHOTS}/p30-status-public.png`, fullPage: true });

  // hospitals' staff see it on their own pages (the banner is cached for 30 s per web server)
  const admin = await browser.newPage();
  await staffLogin(admin, CITY, 'admin@citycare.test', '/admin');
  await expect(async () => {
    await admin.reload();
    await expect(admin.getByText(TITLE)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 60000 });

  // resolve it
  const card = support.getByRole('form', { name: `Update ${TITLE}` });
  await card.getByLabel('Status').selectOption('RESOLVED');
  await card.getByLabel('Update (public)').fill('Online payment works again.');
  await card.getByRole('button', { name: 'Post update' }).click();
  await expect(support.getByText('Update posted')).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByRole('heading', { name: 'All systems working' }).or(visitor.getByText('All systems working'))).toBeVisible();
  await expect(visitor.getByText(TITLE)).toBeVisible(); // now under "Past 14 days"
});
