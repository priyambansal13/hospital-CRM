import { OIDC_COOKIE, startLogin } from '@mc/auth';
import { getBranding, origin } from '@mc/bff';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

/** Staff sign-in: redirect to Keycloak, asking for this hospital's organization. */
export async function GET(req: NextRequest) {
  const next = req.nextUrl.searchParams.get('next') ?? '/';
  const { slug } = await getBranding();
  const { url, cookie } = await startLogin({ origin: await origin(), orgAlias: slug, next: next.startsWith('/') && !next.startsWith('//') ? next : '/' });
  (await cookies()).set(OIDC_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', path: '/auth', maxAge: 600 });
  return NextResponse.redirect(url);
}
