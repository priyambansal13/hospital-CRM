import { freshSession } from '@mc/auth/fresh';
import { api } from '@mc/bff';

export const dynamic = 'force-dynamic';

/** Waiting chat requests for the desk's alert banner (counts only, no names). */
export async function GET() {
  const s = await freshSession();
  if (!s) return Response.json({ open: 0, emergency: 0 }, { status: 401 });
  const r = await api<{ open: number; emergency: number; oldestMinutes: number | null }>('/api/assistant/v1/assistant/handoffs/summary', { token: s.accessToken })
    .catch(() => ({ open: 0, emergency: 0, oldestMinutes: null }));
  return Response.json(r, { headers: { 'cache-control': 'no-store' } });
}
