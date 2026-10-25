import { expect, type Page, test } from '@playwright/test';
import { CITY, patientOtp, staffLogin, uniquePhone, confirmPayAtHospital } from './helpers';

// Phase 8: a patient books through the patient zone (sign-in mid-flow, first-time profile), books for a family member,
// reschedules, cancels; a taken slot sends the second patient back to pick another; doctor leave cancels a booking.
const phone = uniquePhone();
const pickDay = 2 + (Number(phone.slice(-2)) % 3); // spread runs over different days, within the doctor's 7-day view
const who = `Kavya Menon ${phone.slice(-4)}`;
const kidName = `Ishaan Menon ${phone.slice(-4)}`;

/**
 * Click the n-th date chip among days within the doctor's 7-day "Appointments" view. Full days have no chip, and
 * other suites keep filling Dr. Asha Rao's days, so "the 5th chip" can be 9 days away.
 */
async function pickDate(page: Page, n: number) {
  const links = page.getByRole('navigation', { name: 'Dates' }).getByRole('link');
  const dates = await links.evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).searchParams.get('date')));
  const last = new Date(Date.now() + 6 * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const inView = dates.map((d, i) => ({ d, i })).filter((x) => x.d && x.d <= last);
  await links.nth(inView[Math.min(n, inView.length - 1)].i).click();
}

async function openAsha(page: Page) {
  await page.goto(`${CITY}/care/doctors?q=asha`);
  await page.getByRole('link', { name: 'Dr. Asha Rao' }).click();
  await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible();
  await pickDate(page, pickDay);
}

test.describe.serial('booking', () => {
  test('a new patient picks a time, signs in, creates their record and books', async ({ page }) => {
    await openAsha(page);
    const time = page.locator('.mc-time').first();
    const label = (await time.textContent())!.trim();
    await time.click();
    await expect(page).toHaveURL(/\/login\?next=%2Fcare%2Fbook%2F/);
    await patientOtp(page, phone);
    await expect(page.getByRole('heading', { name: 'Confirm your appointment' })).toBeVisible();
    await expect(page.getByText('First, tell us about you')).toBeVisible();
    await page.getByLabel('Full name').fill(who);
    await page.getByLabel('Date of birth').fill('1992-03-14');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByRole('radio', { name: new RegExp(`${who} \\(you · MRN\\d+\\)`) })).toBeChecked();
    await expect(page.getByText(`, ${label.split(' · ')[0]}`)).toBeVisible();
    await page.getByLabel('Reason for visit (optional)').fill('Follow-up for blood pressure');
    await confirmPayAtHospital(page);
    await expect(page.getByRole('status')).toContainText(/Booked! Your appointment number is APT-\d{4}-\d{6}/);
    const card = page.getByRole('region', { name: 'Upcoming' }).getByRole('article').first();
    await expect(card).toContainText('Dr. Asha Rao');
    await expect(card).toContainText(`For ${who}`);
    await expect(card).toContainText('Confirmed');
  });

  test('the patient adds a child and books for them; reschedules and cancels', async ({ page }) => {
    await page.goto(`${CITY}/login?next=${encodeURIComponent('/care/profile')}`);
    await patientOtp(page, phone);
    await expect(page.getByRole('heading', { name: 'My family' })).toBeVisible();
    const family = page.getByRole('region').filter({ hasText: 'Family members' }).first();
    await page.getByLabel('Full name').nth(1).fill(kidName);
    await page.getByLabel('Date of birth').nth(1).fill('2019-08-20');
    await page.getByLabel('Relation').selectOption('CHILD');
    await page.getByRole('button', { name: 'Add family member' }).click();
    await expect(page.getByRole('status')).toContainText(`${kidName} added to your family`);
    await expect(family.or(page.locator('body'))).toContainText(kidName);

    await openAsha(page);
    await page.locator('.mc-time').nth(1).click();
    await page.getByRole('radio', { name: new RegExp(kidName) }).check();
    await confirmPayAtHospital(page);
    await expect(page.getByRole('status')).toContainText('Booked!');
    const kid = page.getByRole('article').filter({ hasText: `For ${kidName}` });
    await expect(kid).toContainText('Confirmed');

    // reschedule the child's appointment to another day
    await kid.getByRole('link', { name: 'Reschedule' }).click();
    await expect(page.getByRole('heading', { name: 'Reschedule' })).toBeVisible();
    await pickDate(page, pickDay + 1);
    await page.locator('.mc-time').first().click();
    await page.getByRole('button', { name: 'Confirm new time' }).click();
    await expect(page.getByRole('status')).toContainText(/Rescheduled\. New appointment number APT-/);

    // cancel it
    await page.getByRole('article').filter({ hasText: `For ${kidName}` }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('status')).toContainText('Appointment cancelled.');
    await expect(page.getByRole('region', { name: 'Past and cancelled' }).getByRole('article').filter({ hasText: `For ${kidName}` }).first()).toContainText('Cancelled');
  });

  test('when two patients race for one time, the second is sent back to pick another', async ({ browser }) => {
    const [a, b] = [await (await browser.newContext()).newPage(), await (await browser.newContext()).newPage()];
    // both sign in and open the SAME slot's confirmation page
    await openAsha(a);
    const href = await a.locator('.mc-time').last().getAttribute('href');
    const base = uniquePhone();
    // two different people (different phones), even within the same millisecond
    for (const [p, ph] of [[a, base], [b, base.replace('+9195', '+9194')]] as const) {
      await p.goto(`${CITY}${href}`);
      await patientOtp(p, ph);
      await p.getByLabel('Full name').fill(`Racer ${ph.slice(-4)}`);
      await p.getByLabel('Date of birth').fill('1990-01-01');
      await p.getByRole('button', { name: 'Save and continue' }).click();
      await expect(p.getByRole('button', { name: /^(Continue|Confirm booking)$/ })).toBeVisible();
    }
    await confirmPayAtHospital(a);
    await expect(a.getByRole('status')).toContainText('Booked!');
    await confirmPayAtHospital(b);
    await expect(b.getByText('Sorry, that time was just booked by someone else.')).toBeVisible();
    await expect(b.getByRole('heading', { name: 'Book an appointment' })).toBeVisible();
  });

  test('doctor sees the booking; leave that day cancels it and the patient is told why', async ({ page, browser }) => {
    await staffLogin(page, CITY, 'asha.rao@citycare.test', '/doctor/appointments');
    const row = page.getByRole('row', { name: new RegExp(who) });
    await expect(row).toContainText('Follow-up for blood pressure');
    const dayTitle = (await page.locator('.mc-card', { has: row }).getByRole('heading').textContent())!;
    const date = new Date(`${dayTitle.split(' · ')[0]} ${new Date().getFullYear()} 12:00 UTC`);
    if (date.getTime() < Date.now() - 86_400_000) date.setFullYear(date.getFullYear() + 1);
    const iso = date.toISOString().slice(0, 10);

    await page.goto(`${CITY}/doctor/schedule`);
    await page.getByLabel('From', { exact: true }).fill(iso);
    await page.getByLabel('To', { exact: true }).fill(iso);
    await page.getByLabel('Reason (optional)').fill('E2E leave');
    await page.getByRole('button', { name: 'Add leave' }).click();
    await expect(page.getByRole('status')).toContainText(/booked appointments? cancelled/);

    const p = await (await browser.newContext()).newPage();
    await p.goto(`${CITY}/login?next=${encodeURIComponent('/care/appointments')}`);
    await patientOtp(p, phone);
    await expect(p.getByRole('region', { name: 'Past and cancelled' }).getByRole('article').filter({ hasText: `For ${who}` }).first()).toContainText('The doctor is unavailable that day.');

    // clean up the leave (and any left behind by an earlier interrupted run)
    const leaves = page.getByRole('row', { name: /E2E leave/ });
    for (let n = await leaves.count(); n > 0; n--) {
      await leaves.first().getByRole('button', { name: 'Cancel leave' }).click();
      await expect(leaves).toHaveCount(n - 1);
    }
    await expect(page.getByRole('status')).toContainText('Leave cancelled');
  });
});
