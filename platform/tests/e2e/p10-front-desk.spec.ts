import { expect, test } from '@playwright/test';
import { CITY, staffLogin, uniquePhone } from './helpers';

// Phase 10: a receptionist registers a walk-in, books them into the doctor's queue and checks them in; the token
// appears on the doctor's open "Today's queue" screen without a reload; the doctor calls them in and completes the
// visit, and the desk board updates live too. (desk@citycare.test is created by `mc test queue` / the admin.)
const phone = uniquePhone();
const who = `Meena Walkin ${phone.slice(-4)}`;

test.describe.serial('front desk and live queue', () => {
  test('walk-in → check-in → token on the doctor’s screen instantly → visit completed', async ({ browser }) => {
    const doctor = await (await browser.newContext()).newPage();
    const desk = await (await browser.newContext()).newPage();

    await staffLogin(doctor, CITY, 'asha.rao@citycare.test', '/doctor/queue');
    await expect(doctor.getByRole('heading', { name: "Today's queue" })).toBeVisible();
    await expect(doctor.locator('.mc-live[data-state="live"]')).toBeVisible();

    await staffLogin(desk, CITY, 'desk@citycare.test', '/desk');
    await expect(desk.getByRole('heading', { name: 'Front desk' })).toBeVisible();
    await desk.getByRole('link', { name: 'Sector 44' }).click(); // Dr. Asha Rao's branch
    await expect(desk.getByText('Sector 44 ·')).toBeVisible();
    await expect(desk.locator('.mc-live[data-state="live"]')).toBeVisible();
    await desk.getByRole('link', { name: 'New walk-in' }).click();

    // not registered yet → register with the searched number
    await desk.getByLabel('Mobile, MRN or name').fill(phone);
    await desk.getByRole('button', { name: 'Search' }).click();
    await expect(desk.getByText('No patient with this mobile number yet')).toBeVisible();
    await expect(desk.getByLabel('Mobile number')).toHaveValue(phone);
    await desk.getByLabel('Full name').fill(who);
    await desk.getByLabel('Date of birth').fill('1988-11-05');
    await desk.getByRole('button', { name: 'Register and book' }).click();

    await expect(desk.getByRole('heading', { name: `Book a visit for ${who}` })).toBeVisible();
    await desk.getByRole('link', { name: /Dr\. Asha Rao · \d+ waiting/ }).click();
    await desk.getByRole('radio', { name: /Join the queue now/ }).check();
    await desk.getByLabel('Reason for visit (optional)').fill('Fever since yesterday');
    await expect(desk.getByLabel('Check in now (patient is here)')).toBeChecked();
    await desk.getByRole('button', { name: 'Book' }).click();

    const flash = desk.locator('.mc-alert').filter({ hasText: who });
    await expect(flash).toContainText(new RegExp(`${who} checked in — token \\d+ with Dr\\. Asha Rao \\(APT-\\d{4}-\\d{6}\\)`));
    const text = (await flash.textContent())!;
    const token = text.match(/token (\d+)/)![1];
    const apt = text.match(/APT-\d{4}-\d{6}/)![0];

    // the doctor's screen, never reloaded by the test, now shows the patient with their token
    const row = doctor.getByTestId(`queue-${apt}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText(who);
    await expect(row.getByLabel(`Token ${token}`)).toBeVisible();
    await expect(doctor.locator('.mc-live')).toContainText(`checked in · token ${token}`);

    await row.getByRole('button', { name: /Call in|Start/ }).click();
    await expect(doctor.locator('.mc-alert').filter({ hasText: 'Now seeing' })).toContainText(`Now seeing ${who} (token ${token})`);
    const now = doctor.getByTestId(`queue-${apt}`);
    await now.getByRole('button', { name: 'Complete visit' }).click();
    await expect(doctor.locator('.mc-alert').filter({ hasText: 'completed' })).toContainText(`Visit with ${who} completed`);

    // the desk board followed along live
    const deskRow = desk.getByRole('row').filter({ has: desk.getByTestId(`desk-${apt}`) });
    await expect(deskRow).toContainText('done', { timeout: 10_000 });
    await expect(deskRow.getByLabel(`Token ${token}`)).toBeVisible();
  });

  test('registering a second owner for the same phone is refused; family members can be added', async ({ page }) => {
    await staffLogin(page, CITY, 'desk@citycare.test', '/desk/patients');
    await page.getByLabel('Mobile, MRN or name').fill(phone);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('row', { name: new RegExp(who) })).toContainText('owner');
    await expect(page.getByRole('heading', { name: `Add a family member to ${phone}` })).toBeVisible();
    await page.getByLabel('Full name').fill(`Tara Walkin ${phone.slice(-4)}`);
    await page.getByLabel('Date of birth').fill('2020-02-02');
    await expect(page.getByLabel('Who is this?')).toHaveValue('CHILD');
    await page.getByRole('button', { name: 'Register and book' }).click();
    await expect(page.getByRole('heading', { name: `Book a visit for Tara Walkin ${phone.slice(-4)}` })).toBeVisible();

    await page.goto(`${CITY}/desk/patients?q=${encodeURIComponent(phone)}`);
    await page.getByLabel('Full name').fill('Somebody Else');
    await page.getByLabel('Date of birth').fill('1970-01-01');
    await page.getByLabel('Who is this?').selectOption('SELF');
    await page.getByRole('button', { name: 'Register and book' }).click();
    await expect(page.locator('.mc-alert-error')).toContainText(`already belongs to ${who}`);
  });

  test('a doctor cannot open the front desk; a receptionist cannot open admin', async ({ browser }) => {
    const doc = await (await browser.newContext()).newPage();
    await staffLogin(doc, CITY, 'asha.rao@citycare.test', '/doctor/queue');
    await doc.goto(`${CITY}/desk`);
    await expect(doc).toHaveURL(/\?denied=desk/);
    const desk = await (await browser.newContext()).newPage();
    await staffLogin(desk, CITY, 'desk@citycare.test', '/desk');
    await expect(desk.getByRole('navigation', { name: 'Main' })).toContainText('Front desk');
    await desk.goto(`${CITY}/admin`);
    await expect(desk).toHaveURL(/\?denied=admin/);
  });
});
