import { freshSession } from '@mc/auth/fresh';
import { origin, proxyFile } from '@mc/bff';

export const dynamic = 'force-dynamic';

/** The current verified report PDF (diagnostics-service checks it is the caller's own order and audits the download). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await freshSession();
  if (!s) return Response.redirect(`${await origin()}/login`, 302);
  return proxyFile(`/api/diagnostics/v1/lab-orders/${encodeURIComponent((await params).id)}/report.pdf`, s.accessToken);
}
