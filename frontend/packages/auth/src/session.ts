import 'server-only';
import { origin } from '@mc/bff';
import { cookies } from 'next/headers.js';
import { EncryptJWT, jwtDecrypt } from 'jose';

/**
 * Session = two httpOnly cookies on the hospital host, encrypted with SESSION_SECRET (A256GCM): the access token
 * and the refresh token are kept apart so each stays under the 4 KB cookie limit. Shared by every zone because
 * all zones are served through the shell on the same host.
 */
export interface Session {
  kind: 'staff' | 'patient';
  accessToken: string;
  /** epoch seconds */
  expiresAt: number;
  email?: string;
  name?: string;
}

export const ACCESS_COOKIE = 'mc_at';
export const REFRESH_COOKIE = 'mc_rt';
const MAX_AGE_S = 30 * 24 * 3600;
const MAX_COOKIE_BYTES = 4000;

function key() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET missing (run mc configure)');
  return new Uint8Array(Buffer.from(s, 'base64url')).slice(0, 32);
}

export async function seal(payload: Record<string, unknown>, ttlS = MAX_AGE_S): Promise<string> {
  return new EncryptJWT(payload).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).setIssuedAt().setExpirationTime(`${ttlS}s`).encrypt(key());
}

export async function unseal<T>(value: string | undefined): Promise<T | undefined> {
  if (!value) return undefined;
  try {
    return (await jwtDecrypt(value, key())).payload as T;
  } catch {
    return undefined;
  }
}

/** Secure cookies whenever the hospital host is served over HTTPS (always in production). */
const cookieOpts = async () => ({ httpOnly: true, sameSite: 'lax' as const, path: '/', secure: (await origin()).startsWith('https:') });

/** Read the session (any server context). Expired access tokens are returned; see needsRefresh(). */
export async function getSession(): Promise<Session | undefined> {
  return unseal<Session>((await cookies()).get(ACCESS_COOKIE)?.value);
}

export async function getRefreshToken(): Promise<{ kind: Session['kind']; refreshToken: string } | undefined> {
  return unseal((await cookies()).get(REFRESH_COOKIE)?.value);
}

export const needsRefresh = (s: Session) => s.expiresAt - 30 < Date.now() / 1000;

/** Write the session (route handlers and server actions only). */
export async function setSession(s: Session, refreshToken: string) {
  const jar = await cookies();
  const opts = await cookieOpts();
  const access = await seal({ ...s });
  // browsers silently drop cookies over 4 KB: the user would just land on the login page again with no clue why
  if (access.length > MAX_COOKIE_BYTES) throw new Error(`the sign-in token is too large to keep (${access.length} bytes); please tell support`);
  jar.set(ACCESS_COOKIE, access, { ...opts, maxAge: MAX_AGE_S });
  jar.set(REFRESH_COOKIE, await seal({ kind: s.kind, refreshToken }), { ...opts, maxAge: MAX_AGE_S });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}
