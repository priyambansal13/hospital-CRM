'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Console support actions on one hospital (review H-7): trial extension, credit note, take offline, delete. */
const back = async (id: string, q: Record<string, string>) => redirect(`${await origin()}/platform/hospitals/${id}?${new URLSearchParams(q)}`);
const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : 'Something went wrong');
const H = (id: string) => `/api/subscription/v1/platform/hospitals/${encodeURIComponent(id)}`;

export async function supportAction(f: FormData) {
  const id = String(f.get('hospitalId'));
  const op = String(f.get('op'));
  const reason = String(f.get('reason') ?? '').trim();
  const { accessToken: token } = await actionSession();
  let ok: string;
  try {
    if (op === 'trial') {
      const r = await api<{ trialEndsAt: string }>(`${H(id)}/trial`, { token, body: { days: Number(f.get('days')), reason } });
      ok = `Trial now ends ${new Date(r.trialEndsAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}`;
    } else if (op === 'credit') {
      const r = await api<{ openCredit: number }>(`${H(id)}/credits`, { token, body: { amount: Number(f.get('amount')), reason } });
      ok = `Credit added: ₹${r.openCredit} comes off the next invoice`;
    } else {
      const status = op === 'suspend' ? 'SUSPENDED' : op === 'delete' ? 'DELETED' : 'ACTIVE';
      await api(`${H(id)}/status`, { token, body: { status, reason, confirmSlug: String(f.get('confirmSlug') ?? '') || undefined } });
      ok = status === 'SUSPENDED' ? 'Hospital taken offline' : status === 'DELETED' ? 'Hospital deleted (data kept until purged)' : 'Hospital back online';
    }
  } catch (e) {
    return back(id, { error: msg(e) });
  }
  return back(id, { ok });
}
