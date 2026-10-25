import { freshSession } from '@mc/auth/fresh';
import { proxyEventStream } from '@mc/bff';

export const dynamic = 'force-dynamic';

/** Live queue signals for one doctor (server-sent events from the realtime gateway). */
export async function GET(req: Request) {
  const s = await freshSession();
  if (!s) return new Response('sign in required', { status: 401 });
  const doctorId = new URL(req.url).searchParams.get('doctorId') ?? '';
  return proxyEventStream(`/api/realtime/v1/realtime/queue?doctorId=${encodeURIComponent(doctorId)}`, s.accessToken, req.signal);
}
