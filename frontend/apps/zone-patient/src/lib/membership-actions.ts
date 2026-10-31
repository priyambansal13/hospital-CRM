'use server';
import { actionSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import { errorText } from './booking';

/** Join (or renew) a tier: billing opens an invoice, the patient pays on the usual pay page. */
export async function joinMembership(form: FormData) {
  const { accessToken: token } = await actionSession();
  let invoiceId: string;
  try {
    ({ invoiceId } = await api<{ membershipId: string; invoiceId: string }>('/api/billing/v1/memberships', { token, body: { planId: form.get('planId') } }));
  } catch (e) {
    redirect(`${await origin()}/care/membership?${new URLSearchParams({ error: errorText(e) })}`);
  }
  redirect(`${await origin()}/care/pay/${invoiceId}`);
}
