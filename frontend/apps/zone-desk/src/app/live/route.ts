import { freshSession } from '@mc/auth/fresh';
import { proxyEventStream } from '@mc/bff';

export const dynamic = 'force-dynamic';

/** Live board signals for one branch (server-sent events from the realtime gateway). */
export async function GET(req: Request) {
  const s = await freshSession();
  if (!s) return new Response('sign in required', { status: 401 });
  const branchId = new URL(req.url).searchParams.get('branchId') ?? '';
  return proxyEventStream(`/api/realtime/v1/realtime/queue?branchId=${encodeURIComponent(branchId)}`, s.accessToken, req.signal);
}
