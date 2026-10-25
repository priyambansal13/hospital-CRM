import { clearSession, getRefreshToken, getSession, refreshPatient, refreshStaff, setSession } from '@mc/auth';
import { origin } from '@mc/bff';
import { NextResponse, type NextRequest } from 'next/server';

/** Server components can't set cookies, so they redirect here to refresh an expiring session and come back. */
export async function GET(req: NextRequest) {
  const base = await origin();
  const raw = req.nextUrl.searchParams.get('next') ?? '/';
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  const [s, rt] = await Promise.all([getSession(), getRefreshToken()]);
  const t = s && rt ? (rt.kind === 'staff' ? await refreshStaff(rt.refreshToken) : await refreshPatient(rt.refreshToken)) : undefined;
  if (!s || !t) {
    await clearSession();
    return NextResponse.redirect(`${base}/login?next=${encodeURIComponent(next)}`);
  }
  await setSession({ ...s, accessToken: t.accessToken, expiresAt: t.expiresAt }, t.refreshToken);
  return NextResponse.redirect(`${base}${next}`);
}
