'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const A = '/api/subscription/v1/account';
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const go = async (path: string, q: Record<string, string>) => redirect(`${await origin()}/account${path}?${new URLSearchParams(q)}`);
const message = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : 'Something went wrong');
const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`;

async function call<T>(path: string, method: string, body: unknown = {}): Promise<T> {
  const { accessToken: token } = await actionSession();
  return api<T>(`${A}${path}`, { token, method, body });
}

export async function payNow() {
  try {
    await call('/pay', 'POST');
  } catch (e) {
    return go('', { error: message(e) });
  }
  return go('', { ok: 'Paid: thank you. The subscription is active.' });
}

export async function applyCoupon(f: FormData) {
  try {
    const r = await call<{ code: string; description: string }>('/coupon', 'POST', { code: str(f, 'code') });
    return go('', { ok: `Coupon ${r.code} applied: ${r.description}` });
  } catch (e) {
    return go('', { error: message(e) });
  }
}

export async function setCancel(f: FormData) {
  const cancel = str(f, 'cancel') === '1';
  try {
    await call('/cancel', 'POST', { cancel });
  } catch (e) {
    return go('', { error: message(e) });
  }
  return go('', { ok: cancel ? 'The subscription will end at the end of this billing period.' : 'Cancellation withdrawn.' });
}

export async function changePlan(f: FormData) {
  let r: { applied: 'NOW' | 'AT_PERIOD_END'; at?: string; invoice?: { number: string; total: number }; monthly: { before: number; after: number } };
  try {
    r = await call('/change-plan', 'POST', { plan: str(f, 'plan'), addons: f.getAll('addon').map((code) => ({ code: String(code) })) });
  } catch (e) {
    return go('/plan', { error: message(e) });
  }
  if (r.applied === 'AT_PERIOD_END') return go('/plan', { ok: `Downgrade scheduled for the end of this billing period (${inr(r.monthly.before)} → ${inr(r.monthly.after)} a month before GST). Everything stays as it is until then.` });
  return go('/plan', { ok: r.invoice ? `Upgraded now. Invoice ${r.invoice.number} for the rest of this month: ${inr(r.invoice.total)}.` : 'Plan changed.' });
}
