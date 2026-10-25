import { freshSession } from '@mc/auth/fresh';
import { api, ApiError, origin } from '@mc/bff';

export const dynamic = 'force-dynamic';

/** Audited 5-minute download link from records-service; the browser is sent straight to storage (never proxied). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await freshSession();
  if (!s) return Response.redirect(`${await origin()}/login`, 302);
  try {
    const { url } = await api<{ url: string }>(`/api/records/v1/documents/${encodeURIComponent((await params).id)}/download`, { token: s.accessToken });
    return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  } catch (e) {
    return new Response(e instanceof ApiError ? e.message : 'not available', { status: e instanceof ApiError ? e.status : 500 });
  }
}
