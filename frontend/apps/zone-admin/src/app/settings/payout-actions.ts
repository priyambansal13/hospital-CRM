'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Payout account changes (review B-5): a code is e-mailed to the person first; replacing needs it. */
const go = async (q: Record<string, string>) => redirect(`${await origin()}/admin/settings?${new URLSearchParams(q)}#payments`);
const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : 'Something went wrong');

export async function sendPayoutCode() {
  const { accessToken: token } = await actionSession();
  try {
    const r = await api<{ to: string }>('/api/iam/v1/me/step-up', { token, body: { purpose: 'PAYOUT_ACCOUNT' } });
    return go({ ok: `Code sent to ${r.to}: enter it with the new bank account`, code: 'sent' });
  } catch (e) {
    return go({ error: msg(e) });
  }
}

export async function savePayoutAccount(f: FormData) {
  const { accessToken: token } = await actionSession();
  const s = (k: string) => String(f.get(k) ?? '').trim();
  try {
    await api('/api/billing/v1/payment-account', { token, method: 'PUT', body: {
      businessName: s('businessName'), businessType: s('businessType'), pan: s('pan'), accountNumber: s('accountNumber'), ifsc: s('ifsc'), email: s('email'), stepUpCode: s('stepUpCode') || null,
    } });
  } catch (e) {
    return go({ error: msg(e), ...(f.get('stepUpCode') ? { code: 'sent' } : {}) });
  }
  return go({ ok: 'Bank account saved. The hospital\'s owners have been told by e-mail.' });
}
