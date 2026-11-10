import { getSession } from '@mc/auth';
import { proxyFile } from '@mc/bff';

export const dynamic = 'force-dynamic';

/** The Google Ads offline-conversion file (consented conversions only, e-mails hashed). */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response('Sign in first\n', { status: 401 });
  const days = new URL(req.url).searchParams.get('days') ?? '90';
  return proxyFile(`/api/tenant/v1/platform/growth/conversions/google.csv?days=${encodeURIComponent(days)}`, session.accessToken);
}
