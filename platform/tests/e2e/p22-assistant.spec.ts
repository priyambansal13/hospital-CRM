import { expect, test } from '@playwright/test';
import { CITY, patientOtp, staffLogin, stamp, uniquePhone } from './helpers';

// Phase 22 demo: a patient asks the hospital's AI assistant about visiting hours and fasting and gets the hospital's
// own answers; "crushing chest pain right now" gets the emergency response without the model; the patient asks for
// a person and the front desk sees the chat. The admin checks what the assistant knows.
const who = `Chat Visitor ${stamp()}`;

test.describe.serial('AI assistant', () => {
  test('patient asks about visiting hours and fasting, then an emergency, then asks for a person', async ({ page }) => {
    await page.goto(`${CITY}/login?next=${encodeURIComponent('/care/profile')}`);
    await patientOtp(page, uniquePhone());
    await page.getByLabel('Full name').first().fill(who);
    await page.getByLabel('Date of birth').first().fill('1979-07-07');
    await page.getByRole('button', { name: 'Create my record' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(/saved/i);

    await page.getByRole('link', { name: 'Ask us' }).click();
    await expect(page.getByRole('heading', { name: 'Ask us' })).toBeVisible();
    await expect(page.getByText(/AI assistant: answers come from/)).toBeVisible();
    const log = page.getByRole('log', { name: 'Messages' });

    await page.getByRole('button', { name: 'What are the visiting hours?' }).click();
    await expect(log.locator('[data-kind="ANSWER"]').last()).toContainText('10:00 am to 12:00 noon');
    await expect(log.getByText('From: Visiting hours')).toBeVisible();

    const box = page.getByLabel('Your message');
    await box.fill('Do I need to fast before a blood test?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(log.locator('[data-kind="ANSWER"]').last()).toContainText('plain water');

    await box.fill('crushing chest pain right now');
    await box.press('Enter');
    const alarm = log.getByRole('alert');
    await expect(alarm).toContainText('This could be an emergency.');
    await expect(alarm.getByRole('link', { name: 'Call 112' })).toHaveAttribute('href', 'tel:112');

    await page.getByRole('button', { name: 'Talk to a person' }).first().click();
    await expect(page.getByRole('status').filter({ hasText: 'The hospital will call you back' })).toBeVisible();
    await expect(log.locator('[data-kind="HANDOFF"]')).toContainText('will call you');
  });

  test('the front desk sees the chat request and closes it after calling back', async ({ page }) => {
    await staffLogin(page, CITY, 'desk@citycare.test', '/desk/assistant');
    await expect(page.getByRole('heading', { name: 'Chat requests' })).toBeVisible();
    const card = page.getByRole('article', { name: `Chat request from ${who}` });
    await expect(card).toBeVisible();
    await card.getByText(/Conversation \(\d+ messages\)/).click();
    await expect(card.getByText('crushing chest pain right now')).toBeVisible();
    await card.getByLabel('Note (optional)').fill('Called back, booked with cardiology');
    await card.getByRole('button', { name: 'Called back, close' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(`Chat request from ${who} closed`);
  });

  test('the admin checks what the assistant finds for a question', async ({ page }) => {
    await staffLogin(page, CITY, 'admin@citycare.test', '/admin/knowledge');
    await expect(page.getByRole('heading', { name: 'Assistant knowledge' })).toBeVisible();
    const t = page.getByRole('form', { name: 'Try a question' });
    await t.getByLabel('A question a patient might ask').fill('when can I see my mother in ICU');
    await t.getByRole('button', { name: 'Show what the assistant finds' }).click();
    await expect(page.getByRole('list', { name: 'What the assistant finds' }).getByRole('listitem').first()).toContainText('Visiting hours');
    await expect(page.getByText(/Fasting Blood Sugar/).first()).toBeVisible();
  });
});
