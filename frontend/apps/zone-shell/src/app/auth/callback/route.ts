import { finishLogin, OIDC_COOKIE, setSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const jar = await cookies();
  const base = await origin();
  try {
    const { session, refreshToken, next } = await finishLogin(req.nextUrl.searchParams, jar.get(OIDC_COOKIE)?.value);
    jar.delete({ name: OIDC_COOKIE, path: '/auth' });
    await setSession(session, refreshToken);
    // an invited staff member who signs in becomes ACTIVE in this hospital (best effort; review A-3)
    if (session.kind === 'staff') await api('/api/iam/v1/me/signed-in', { token: session.accessToken, method: 'POST', timeoutMs: 3000 }).catch(() => undefined);
    return NextResponse.redirect(`${base}${next}`);
  } catch (e) {
    return NextResponse.redirect(`${base}/login?error=${encodeURIComponent((e as Error).message)}`);
  }
}
