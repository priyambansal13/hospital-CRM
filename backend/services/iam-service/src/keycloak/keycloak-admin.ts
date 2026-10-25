import { Injectable, Logger } from '@nestjs/common';
import { DomainError, isDev } from '@mc/nest-common';

interface KcUser { id: string; email: string; firstName?: string; lastName?: string }
interface KcOrg { id: string; alias: string; name: string }

/**
 * Minimal Keycloak admin client (service account of client mc-iam). One realm ("medicare"), one Keycloak
 * Organization per hospital (alias = tenant slug); staff tokens carry the organization claim
 * (docs/MULTI-TENANCY.md §5).
 */
@Injectable()
export class KeycloakAdmin {
  private readonly log = new Logger('Keycloak');
  private readonly base = process.env.KEYCLOAK_URL ?? 'http://localhost:61180';
  private readonly realm = process.env.KEYCLOAK_REALM ?? 'medicare';
  private token?: { value: string; exp: number };
  /** organization ids never change for an alias: cache them (saves a search per onboarding) */
  private readonly orgs = new Map<string, KcOrg>();

  private async accessToken() {
    if (this.token && this.token.exp > Date.now() + 10_000) return this.token.value;
    const res = await fetch(`${this.base}/realms/${this.realm}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'mc-iam', client_secret: process.env.MC_IAM_CLIENT_SECRET ?? '' }),
    });
    if (!res.ok) throw new Error(`keycloak token ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown, ok404 = false): Promise<T | undefined> {
    const res = await fetch(`${this.base}/admin/realms/${this.realm}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (ok404 && res.status === 404) return undefined;
    if (!res.ok) throw new DomainError(502, 'IDP_ERROR', `keycloak ${method} ${path} → ${res.status} ${await res.text()}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Keycloak's search matches name/domain, not alias, so page through and match the alias exactly. */
  async findOrganization(alias: string): Promise<KcOrg | undefined> {
    const hit = ((await this.call<KcOrg[]>('GET', `/organizations?search=${encodeURIComponent(`${alias}.medicare.local`)}`)) ?? []).find((o) => o.alias === alias);
    if (hit) return hit;
    for (let first = 0; ; first += 200) {
      const page = (await this.call<KcOrg[]>('GET', `/organizations?first=${first}&max=200`)) ?? [];
      const found = page.find((o) => o.alias === alias);
      if (found || page.length < 200) return found;
    }
  }

  async ensureOrganization(alias: string, name: string): Promise<KcOrg> {
    const cached = this.orgs.get(alias);
    if (cached) return cached;
    const existing = await this.findOrganization(alias);
    if (existing) {
      this.orgs.set(alias, existing);
      return existing;
    }
    // organisation names are unique in Keycloak, hospital names are not (two "City Clinic"s): fall back to "name (alias)"
    const create = (n: string) => this.call('POST', '/organizations', { name: n, alias, enabled: true, domains: [{ name: `${alias}.medicare.local` }] });
    await create(name).catch(async (e: Error) => {
      if (!/409/.test(e.message) || !/same name/i.test(e.message)) throw e;
      await create(`${name} (${alias})`);
    });
    const org = await this.findOrganization(alias);
    if (!org) throw new Error(`organization ${alias} not found after create`);
    this.log.log(`organization ${alias} created`);
    this.orgs.set(alias, org);
    return org;
  }

  /** Allow the hospital's own host(s) to receive login redirects (custom domains get added the same way). */
  async allowWebHost(origin: string) {
    const [client] = (await this.call<any[]>('GET', `/clients?clientId=mc-web`)) ?? [];
    if (!client) throw new Error('client mc-web missing');
    const redirect = `${origin}/*`;
    if (client.redirectUris.includes(redirect)) return;
    client.redirectUris = [...client.redirectUris, redirect];
    client.webOrigins = [...new Set([...(client.webOrigins ?? []), origin])];
    client.attributes = { ...client.attributes, 'post.logout.redirect.uris': [...new Set([...(client.attributes?.['post.logout.redirect.uris'] ?? '').split('##').filter(Boolean), `${origin}/*`])].join('##') };
    await this.call('PUT', `/clients/${client.id}`, client);
  }

  /**
   * Keep access tokens small: Keycloak's default "web-origins" scope copies every allowed origin of the client into
   * each token (`allowed-origins`). mc-web has one origin per hospital (and custom domain), so tokens grew with the
   * number of hospitals until the browser dropped the session cookie (> 4 KB) and staff could not sign in. Our
   * services never read that claim (the browser does not call APIs with the token; zones do, server-side). Idempotent.
   */
  async slimWebTokens() {
    const [client] = (await this.call<any[]>('GET', `/clients?clientId=mc-web`)) ?? [];
    if (!client) throw new Error('client mc-web missing');
    const scopes = (await this.call<{ id: string; name: string }[]>('GET', `/clients/${client.id}/default-client-scopes`)) ?? [];
    const wo = scopes.find((x) => x.name === 'web-origins');
    if (wo) {
      await this.call('DELETE', `/clients/${client.id}/default-client-scopes/${wo.id}`);
      this.log.log('mc-web: web-origins scope removed (no allowed-origins claim in tokens)');
    }
  }

  /**
   * mc-web's login redirects are managed here: exactly the live hospitals' origins (plus the static entries from the
   * realm file). Hosts of deleted hospitals and removed custom domains are dropped. Returns how many were removed.
   */
  async reconcileWebHosts(keepOrigins: Set<string>) {
    const [client] = (await this.call<any[]>('GET', `/clients?clientId=mc-web`)) ?? [];
    if (!client) throw new Error('client mc-web missing');
    const STATIC = new Set(['http://localhost:3400/*']);
    const keep = (u: string) => STATIC.has(u) || !u.endsWith('/*') || keepOrigins.has(u.slice(0, -2));
    const before = client.redirectUris.length;
    client.redirectUris = client.redirectUris.filter(keep);
    client.webOrigins = (client.webOrigins ?? []).filter((o: string) => o === '+' || keepOrigins.has(o));
    const logout = (client.attributes?.['post.logout.redirect.uris'] ?? '').split('##').filter(Boolean);
    client.attributes = { ...client.attributes, 'post.logout.redirect.uris': logout.filter((u: string) => u === '+' || keep(u)).join('##') || '+' };
    const removed = before - client.redirectUris.length;
    if (removed) {
      await this.call('PUT', `/clients/${client.id}`, client);
      this.log.log(`mc-web: ${removed} login redirects of hosts no longer in use removed`);
    }
    return removed;
  }

  async findUserByEmail(email: string): Promise<KcUser | undefined> {
    const users = (await this.call<KcUser[]>('GET', `/users?email=${encodeURIComponent(email)}&exact=true`)) ?? [];
    return users[0];
  }

  /**
   * Create (or find) a staff user. Dev mode: a known password and no required actions, so scripted tests can log
   * in. Otherwise: an email asking the user to set a password and enrol TOTP (staff MFA is mandatory).
   */
  async ensureStaffUser(email: string, name: string): Promise<{ user: KcUser; created: boolean }> {
    const existing = await this.findUserByEmail(email);
    if (existing) return { user: existing, created: false };
    const [firstName, ...rest] = name.split(' ');
    const dev = isDev();
    await this.call('POST', '/users', {
      username: email, email, firstName, lastName: rest.join(' ') || '-', enabled: true, emailVerified: dev,
      requiredActions: dev ? [] : ['UPDATE_PASSWORD', 'CONFIGURE_TOTP', 'VERIFY_EMAIL'],
      credentials: dev ? [{ type: 'password', value: process.env.DEV_STAFF_PASSWORD, temporary: false }] : [],
    });
    const user = await this.findUserByEmail(email);
    if (!user) throw new Error(`user ${email} not found after create`);
    if (!dev) await this.call('PUT', `/users/${user.id}/execute-actions-email?lifespan=259200`, ['UPDATE_PASSWORD', 'CONFIGURE_TOTP', 'VERIFY_EMAIL']);
    return { user, created: true };
  }

  /** Add a user to an organization; "already a member" (409) counts as success. */
  async addMember(orgId: string, userId: string) {
    const res = await fetch(`${this.base}/admin/realms/${this.realm}/organizations/${orgId}/members`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(userId),
    });
    if (!res.ok && res.status !== 409) throw new DomainError(502, 'IDP_ERROR', `keycloak add member → ${res.status} ${await res.text()}`);
  }
}
