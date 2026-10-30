'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Resubscribe after the trial ended or the subscription was cancelled (review D-7). */
export async function resubscribe() {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    const r = await api<{ invoice: { number: string; total: number } }>('/api/subscription/v1/account/reactivate', { token, body: {} });
    q = { ok: `Welcome back: the subscription is active again (invoice ${r.invoice.number}, ₹${r.invoice.total}, paid)` };
  } catch (e) {
    q = { error: e instanceof ApiError ? e.message : 'Could not resubscribe' };
  }
  redirect(`${await origin()}/account?${new URLSearchParams(q)}`);
}
