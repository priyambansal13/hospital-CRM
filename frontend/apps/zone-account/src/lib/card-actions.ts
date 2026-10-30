'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/**
 * Add or change the card: the owner goes to the payment gateway's own page and comes back to /account/card/return.
 * Card details never pass through this app (review B-6).
 */
export async function startCard() {
  const { accessToken: token } = await actionSession();
  let url: string;
  try {
    ({ url } = await api<{ url: string }>('/api/subscription/v1/account/card-session', { token, body: { returnUrl: `${await origin()}/account/card/return` } }));
  } catch (e) {
    redirect(`${await origin()}/account?${new URLSearchParams({ error: e instanceof ApiError ? e.message : 'Could not open the card page' })}`);
  }
  redirect(url);
}
