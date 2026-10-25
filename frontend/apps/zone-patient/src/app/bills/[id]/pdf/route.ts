import { freshSession } from '@mc/auth/fresh';
import { proxyFile } from '@mc/bff';

export const dynamic = 'force-dynamic';

/** Invoice / receipt PDF (billing-service checks it belongs to the signed-in patient). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await freshSession();
  if (!s) return new Response('sign in required', { status: 401 });
  return proxyFile(`/api/billing/v1/invoices/${encodeURIComponent((await params).id)}/pdf`, s.accessToken);
}
