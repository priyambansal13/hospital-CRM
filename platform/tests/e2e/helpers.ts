import { type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

export const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
export const CITY = 'http://citycare.localhost:3400';
export const SUN = 'http://sunrise.localhost:3400';
export const stamp = () => Date.now().toString().slice(-6);

/** Keycloak with Organizations uses identifier-first login: username screen, then password screen. */
export async function staffLogin(page: Page, base: string, email: string, next = '/admin') {
  await page.goto(`${base}/login?next=${encodeURIComponent(next)}`);
  await page.getByRole('link', { name: 'Staff sign-in' }).click();
  await page.locator('#username').fill(email);
  if (!(await page.locator('#password').isVisible())) await page.locator('#kc-login').click();
  await page.locator('#password').fill(env.DEV_STAFF_PASSWORD);
  await page.locator('#kc-login').click();
}

/**
 * The newest login code sent to `phone` after `since` (ms epoch); waits for it to arrive in Mailpit. Waits a moment
 * after the first one shows up: a form submitted twice (dev-mode re-render) sends a second code that replaces the first.
 */
export async function latestOtp(phone: string, since = Date.now() - 60_000) {
  const newest = async () => {
    const r = await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(`to:${phone.replace('+', '')}@sms.medicare.local`)}`)).json();
    // only login-code messages: appointment SMS to the same phone contain 6-digit runs too (APT-2026-000250)
    const msgs = (r.messages ?? []).filter((x: { Created: string; Snippet?: string }) => Date.parse(x.Created) >= since - 1000 && /is your .* login code/.test(x.Snippet ?? ''));
    msgs.sort((a: { Created: string }, b: { Created: string }) => Date.parse(b.Created) - Date.parse(a.Created));
    return msgs[0]?.Snippet?.match(/^(\d{6}) is your/)?.[1] as string | undefined;
  };
  for (let i = 0; i < 40; i++) {
    if (await newest()) {
      await new Promise((res) => setTimeout(res, 1000));
      return (await newest())!;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('no OTP received');
}

/** Sign in as a patient on the login page the browser is on (OTP from Mailpit). */
export async function patientOtp(page: Page, phone: string) {
  await page.getByLabel('Mobile number').fill(phone);
  const since = Date.now();
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('Code').fill(await latestOtp(phone, since));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
}

export const uniquePhone = () => `+9195${Date.now().toString().slice(-8)}`;

/** Book on the confirmation page paying at the hospital (online payment is offered when billing is active). */
export async function confirmPayAtHospital(page: Page) {
  const atHospital = page.getByRole('radio', { name: 'Pay at the hospital' });
  if (await atHospital.count()) await atHospital.check();
  await page.getByRole('button', { name: /^(Continue|Confirm booking)$/ }).click();
}
