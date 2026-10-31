import { expect, test } from '@playwright/test';
import { CITY, env, patientOtp, stamp, uniquePhone } from './helpers';

// Phase 23 demo: the patient asks the assistant for a doctor and a time, sees the options and a Confirm card, taps
// Confirm, and the appointment is in "My appointments", booked through the normal booking API.
const G = 'http://localhost:61000';
const KC = 'http://localhost:61180/realms/medicare/protocol/openid-connect/token';
const sfx = stamp().replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
const doctor = `Dr. Meera ${sfx[0].toUpperCase()}${sfx.slice(1)}`;
const who = `Concierge Visitor ${stamp()}`;

async function api(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': 'citycare.localhost', authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? {} : r.json();
}

test.describe.serial('AI assistant books with a Confirm card', () => {
  test.beforeAll(async () => {
    const admin = (await (await fetch(KC, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: 'admin@citycare.test', password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:citycare' }) })).json()).access_token;
    const branch = ((await api('GET', '/api/tenant/v1/branches', admin)) as { name: string; id: string }[]).find((b) => b.name === 'Sector 44')!;
    const d = await api('POST', '/api/provider/v1/doctors', admin, { name: doctor, email: `e2e.concierge.${sfx}@citycare.test`, registrationNo: `E2E/${sfx}`, specialties: [{ code: 'DERMATOLOGY', primary: true }], branches: [{ branchId: branch.id, fee: 350 }], consultModes: ['IN_PERSON'] });
    await api('POST', `/api/provider/v1/doctors/${d.id}/status`, admin, { status: 'ACTIVE' });
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${G}/api/scheduling/v1/doctors/${d.id}/availability`, { method: 'POST', headers: { 'x-tenant-host': 'citycare.localhost', authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify({ days: [1, 2, 3, 4, 5, 6, 7], branchId: branch.id, startTime: '09:00', endTime: '12:00', slotMinutes: 30 }) });
      if (r.status < 300) break;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    // searchable (search-service follows the directory's events)
    for (let i = 0; i < 40; i++) {
      const s = await (await fetch(`${G}/api/search/v1/public/search/doctors?q=${encodeURIComponent(`meera ${sfx}`)}`, { headers: { 'x-tenant-host': 'citycare.localhost' } })).json();
      if (s.items?.some((x: { id: string }) => x.id === d.id)) break;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  });

  test('patient asks for a doctor tomorrow morning, confirms the card, and sees the booking', async ({ page }) => {
    await page.goto(`${CITY}/login?next=${encodeURIComponent('/care/profile')}`);
    await patientOtp(page, uniquePhone());
    await page.getByLabel('Full name').first().fill(who);
    await page.getByLabel('Date of birth').first().fill('1983-08-08');
    await page.getByRole('button', { name: 'Create my record' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText(/saved/i);

    await page.getByRole('link', { name: 'Ask us' }).click();
    await expect(page.getByText(/never books anything until you tap Confirm/)).toBeVisible();
    const log = page.getByRole('log', { name: 'Messages' });
    await page.getByLabel('Your message').fill(`Book an appointment with ${doctor} tomorrow morning`);
    await page.getByRole('button', { name: 'Send' }).click();

    const card = log.getByLabel(`Book ${doctor}`);
    await expect(card).toContainText('09:00');
    await expect(card).toContainText('₹350, pay at the hospital');
    await expect(log.locator('[data-kind="ANSWER"]').last()).toContainText('Tap Confirm');

    await card.getByRole('button', { name: 'Confirm booking' }).click();
    await expect(card.getByRole('status')).toContainText(/Done: APT-/);
    await expect(log.locator('[data-kind="ACTION"]').last()).toContainText('Booked. Your appointment number is APT-');

    await page.goto(`${CITY}/care/appointments`);
    await expect(page.getByText(doctor).first()).toBeVisible();
  });
});
