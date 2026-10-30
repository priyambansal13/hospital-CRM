import { freshSession } from '@mc/auth/fresh';
import { api, ApiError, origin } from '@mc/bff';

export const dynamic = 'force-dynamic';

/** Back from the payment gateway's card page: the card is confirmed with the gateway (not trusted from the URL). */
export async function GET(req: Request) {
  const base = `${await origin()}/account`;
  const s = await freshSession();
  if (!s) return Response.redirect(`${await origin()}/login?next=/account`, 303);
  const session = new URL(req.url).searchParams.get('session') ?? '';
  let q: Record<string, string>;
  try {
    const r = await api<{ brand: string; last4: string; paidUp: boolean; hadUnpaid?: boolean }>(`/api/subscription/v1/account/card-session/${encodeURIComponent(session)}/complete`, { token: s.accessToken, method: 'POST', body: {} });
    q = r.paidUp ? { ok: `${r.brand} ending ${r.last4} saved for renewals${r.hadUnpaid ? '; open invoices paid' : ''}` } : { error: `${r.brand} ending ${r.last4} saved, but the open invoices could not be charged: try another card` };
  } catch (e) {
    q = { error: e instanceof ApiError ? e.message : 'The card could not be saved' };
  }
  return Response.redirect(`${base}?${new URLSearchParams(q)}`, 303);
}
