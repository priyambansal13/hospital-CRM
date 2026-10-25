import { clearSession, getRefreshToken, getSession, logoutPatient, logoutUrl } from '@mc/auth';
import { origin } from '@mc/bff';
import { NextResponse } from 'next/server';

export async function GET() {
  const base = await origin();
  const [s, rt] = await Promise.all([getSession(), getRefreshToken()]);
  await clearSession();
  if (s?.kind === 'patient' && rt) await logoutPatient(rt.refreshToken);
  return NextResponse.redirect(s?.kind === 'staff' ? logoutUrl(base) : `${base}/`);
}
