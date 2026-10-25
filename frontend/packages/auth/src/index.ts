import 'server-only';
import { origin } from '@mc/bff';
import { redirect } from 'next/navigation.js';
import { getSession, needsRefresh, type Session } from './session.js';

export * from './oidc.js';
export * from './patient.js';
export * from './session.js';
export { freshSession } from './fresh.js';

/**
 * For server components: the current session, or a redirect to sign-in / to the shell's refresh route.
 * Absolute URLs because zones have their own basePath while /auth/* lives in the shell.
 */
export async function requireSession(currentPath: string): Promise<Session> {
  const s = await getSession();
  const base = await origin();
  if (!s) redirect(`${base}/login?next=${encodeURIComponent(currentPath)}`);
  if (needsRefresh(s)) redirect(`${base}/auth/refresh?next=${encodeURIComponent(currentPath)}`);
  return s;
}

/**
 * For server actions: the current session, refreshed in place when the access token is about to expire
 * (actions may set cookies; server components may not).
 */
export async function actionSession(): Promise<Session> {
  const { freshSession } = await import('./fresh.js');
  const s = await freshSession();
  if (!s) redirect(`${await origin()}/login`);
  return s;
}

