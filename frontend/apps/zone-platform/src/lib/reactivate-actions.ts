'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Support brings an expired or cancelled hospital back (review D-7). */
export async function reactivateHospital(f: FormData) {
  const id = String(f.get('hospitalId'));
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    const r = await api<{ invoice: { number: string; paid: boolean } }>(`/api/subscription/v1/platform/hospitals/${encodeURIComponent(id)}/reactivate`, {
      token, body: { offline: f.get('offline') === 'on', reason: String(f.get('reason') ?? '').trim() },
    });
    q = { ok: `Reactivated: invoice ${r.invoice.number} ${r.invoice.paid ? 'paid by card' : 'waits for the bank transfer'}` };
  } catch (e) {
    q = { error: e instanceof ApiError ? e.message : 'Could not reactivate' };
  }
  redirect(`${await origin()}/platform/hospitals/${id}?${new URLSearchParams(q)}`);
}
