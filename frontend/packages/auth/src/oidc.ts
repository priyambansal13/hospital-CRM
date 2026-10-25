import 'server-only';
import { decodeJwt } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { seal, type Session, unseal } from './session.js';

/** Staff sign-in: OIDC authorization code + PKCE with Keycloak, asking for the hospital's organization. */
const issuer = () => process.env.KEYCLOAK_ISSUER ?? 'http://localhost:61180/realms/medicare';
const clientId = () => process.env.KEYCLOAK_CLIENT_ID ?? 'mc-web';
const b64 = (b: Buffer) => b.toString('base64url');

export interface PendingLogin {
  state: string;
  verifier: string;
  nonce: string;
  next: string;
  redirectUri: string;
}

export const OIDC_COOKIE = 'mc_oidc';

export async function startLogin(opts: { origin: string; orgAlias: string; next: string }) {
  const p: PendingLogin = { state: b64(randomBytes(16)), verifier: b64(randomBytes(32)), nonce: b64(randomBytes(16)), next: opts.next, redirectUri: `${opts.origin}/auth/callback` };
  const challenge = b64(createHash('sha256').update(p.verifier).digest());
  const url = new URL(`${issuer()}/protocol/openid-connect/auth`);
  url.search = new URLSearchParams({
    client_id: clientId(), response_type: 'code', redirect_uri: p.redirectUri,
    scope: `openid email profile organization:${opts.orgAlias}`,
    state: p.state, nonce: p.nonce, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), cookie: await seal({ ...p }, 600) };
}

export async function finishLogin(params: URLSearchParams, pendingCookie: string | undefined) {
  const p = await unseal<PendingLogin>(pendingCookie);
  if (!p || params.get('state') !== p.state) throw new Error('login expired or state mismatch; please try again');
  if (params.get('error')) throw new Error(params.get('error_description') ?? params.get('error')!);
  const res = await fetch(`${issuer()}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId(), code: params.get('code') ?? '', redirect_uri: p.redirectUri, code_verifier: p.verifier }),
  });
  const t = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !t.access_token) throw new Error(t.error_description ?? 'token exchange failed');
  const id = decodeJwt(t.id_token ?? '');
  if (id.nonce !== p.nonce) throw new Error('nonce mismatch');
  const session: Session = { kind: 'staff', accessToken: t.access_token, expiresAt: Math.floor(Date.now() / 1000) + (t.expires_in ?? 300), email: id.email as string, name: id.name as string };
  return { session, refreshToken: t.refresh_token ?? '', next: p.next };
}

export async function refreshStaff(refreshToken: string) {
  const res = await fetch(`${issuer()}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId(), refresh_token: refreshToken }),
  });
  if (!res.ok) return undefined;
  const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Math.floor(Date.now() / 1000) + t.expires_in };
}

export function logoutUrl(origin: string) {
  const url = new URL(`${issuer()}/protocol/openid-connect/logout`);
  url.search = new URLSearchParams({ client_id: clientId(), post_logout_redirect_uri: `${origin}/` }).toString();
  return url.toString();
}
