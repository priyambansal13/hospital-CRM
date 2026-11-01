import { freshSession } from '@mc/auth/fresh';
import { proxyFile } from '@mc/bff';
import { periodOf } from '../lib';

export const dynamic = 'force-dynamic';

/** CSV of the explored metric (analytics-service checks the plan's export feature and the branches). */
export async function GET(req: Request) {
  const s = await freshSession();
  if (!s) return new Response('sign in required', { status: 401 });
  const sp = new URL(req.url).searchParams;
  const period = periodOf(sp.get('period') ?? undefined);
  const q = new URLSearchParams({ metric: sp.get('metric') ?? '', from: period.from, to: period.to });
  for (const [k, v] of [['groupBy', sp.get('by')], ['branchId', sp.get('branch')]] as const) if (v) q.set(k, v);
  return proxyFile(`/api/analytics/v1/analytics/export.csv?${q}`, s.accessToken);
}
