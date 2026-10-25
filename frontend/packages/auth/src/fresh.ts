import 'server-only';
import { refreshStaff } from './oidc.js';
import { refreshPatient } from './patient.js';
import { getRefreshToken, getSession, needsRefresh, type Session, setSession } from './session.js';

/**
 * For route handlers (e.g. a live stream): the session with a usable access token, refreshed in place if needed,
 * or undefined when signed out / the refresh failed (no redirect: the caller answers 401). Its own entry point
 * (@mc/auth/fresh) because route handlers must not import next/navigation.
 */
export async function freshSession(): Promise<Session | undefined> {
  const s = await getSession();
  if (!s) return undefined;
  if (!needsRefresh(s)) return s;
  const rt = await getRefreshToken();
  const t = rt ? (rt.kind === 'staff' ? await refreshStaff(rt.refreshToken) : await refreshPatient(rt.refreshToken)) : undefined;
  if (!t) return undefined;
  const next: Session = { ...s, accessToken: t.accessToken, expiresAt: t.expiresAt };
  await setSession(next, t.refreshToken);
  return next;
}
