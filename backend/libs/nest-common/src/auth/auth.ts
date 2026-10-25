import { type CanActivate, createParamDecorator, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Actor, normalizeHost, type PlacementSource, RequestContext } from '@mc/tenancy';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import { DomainError } from '../errors.js';
import { isDev } from '../env.js';

export const PLACEMENTS = Symbol('PLACEMENTS');

/**
 * Route access levels (every route has exactly one; default is 'auth'). The cross-tenant leak test reads them
 * from GET /internal/routes.
 *  - public:        no tenant, no token (health, JWKS)
 *  - tenant-public: tenant from the host, no token (branding, OTP request)
 *  - auth:          tenant from the host + a token issued for THAT tenant
 *  - internal:      service-to-service, x-internal-token header (mesh mTLS in production)
 */
export type Access = 'public' | 'tenant-public' | 'auth' | 'internal';
export const ACCESS = 'mc:access';
export const Public = () => SetMetadata(ACCESS, 'public' satisfies Access);
export const TenantPublic = () => SetMetadata(ACCESS, 'tenant-public' satisfies Access);
export const Internal = () => SetMetadata(ACCESS, 'internal' satisfies Access);

/** `@CurrentActor() actor: Actor` (only on 'auth' routes). */
export const CurrentActor = createParamDecorator(() => RequestContext.current()?.actor);

export const TENANT_HOST_HEADER = 'x-tenant-host';
const unauth = (code: string, msg: string) => new DomainError(401, code, msg);

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function keySet(url: string) {
  if (!jwks.has(url)) jwks.set(url, createRemoteJWKSet(new URL(url)));
  return jwks.get(url)!;
}

/** Keycloak `organization` claim: ["alias"] or { alias: {...} } depending on mapper settings. */
function orgAliases(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (claim && typeof claim === 'object') return Object.keys(claim);
  return [];
}

/** Verify a bearer token and check it was issued for `tenant`. Throws 401/403 problems. */
export async function verifyActor(authorization: string | undefined, tenant: { id: string; slug: string }): Promise<Actor> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  if (!token) throw unauth('UNAUTHENTICATED', 'missing bearer token');
  let iss: string | undefined;
  try {
    iss = decodeJwt(token).iss;
  } catch {
    throw unauth('UNAUTHENTICATED', 'malformed token');
  }
  const staffIss = process.env.OIDC_STAFF_ISSUER;
  const patientIss = process.env.PATIENT_TOKEN_ISSUER;
  let payload: JWTPayload & Record<string, any>;
  try {
    if (iss && iss === staffIss) ({ payload } = await jwtVerify(token, keySet(`${iss}/protocol/openid-connect/certs`), { issuer: iss }));
    else if (iss && iss === patientIss) ({ payload } = await jwtVerify(token, keySet(`${iss}/jwks.json`), { issuer: iss, audience: 'mc-api' }));
    else throw unauth('UNTRUSTED_ISSUER', 'token issuer not trusted');
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw unauth('INVALID_TOKEN', `invalid token: ${(e as Error).message}`);
  }

  if (iss === staffIss) {
    const allowedClients = ['mc-web', ...(isDev() ? ['mc-dev-cli'] : [])];
    if (!allowedClients.includes(String(payload.azp))) throw unauth('INVALID_TOKEN', 'token not issued to a MediCare app');
    if (!orgAliases(payload.organization).includes(tenant.slug)) throw new DomainError(403, 'TENANT_MISMATCH', 'token was not issued for this hospital');
    return { id: String(payload.sub), kind: 'staff', email: payload.email as string | undefined, token };
  }
  if (payload.typ !== 'patient' || payload.tid !== tenant.id) throw new DomainError(403, 'TENANT_MISMATCH', 'token was not issued for this hospital');
  return { id: String(payload.sub), kind: 'patient', token };
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Global guard. The tenant ALWAYS comes from the request host (X-Tenant-Host from the zone BFF, else Host),
 * never from the body or query; a token is only accepted on the host of the tenant it was issued for.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access>(ACCESS, [ctx.getHandler(), ctx.getClass()]) ?? 'auth';
    const req = ctx.switchToHttp().getRequest();
    const rc = RequestContext.current();
    if (!rc) throw new Error('RequestContext missing: bootstrapService() installs it');

    if (access === 'public') return true;
    if (access === 'internal') {
      const expected = process.env.INTERNAL_API_TOKEN ?? '';
      const got = String(req.headers['x-internal-token'] ?? '');
      if (!expected || !safeEqual(got, expected)) throw unauth('INTERNAL_ONLY', 'internal endpoint');
      return true;
    }

    const host = String(req.headers[TENANT_HOST_HEADER] ?? req.headers.host ?? '');
    if (!host) throw new DomainError(400, 'TENANT_HOST_REQUIRED', 'no tenant host');
    const tenant = await this.placements.resolveHost(normalizeHost(host));
    if (tenant.status !== 'ACTIVE' && tenant.status !== 'READ_ONLY') throw new DomainError(503, 'TENANT_UNAVAILABLE', `hospital is ${tenant.status}`);
    rc.tenant = tenant;
    if (access === 'tenant-public') return true;

    rc.actor = await verifyActor(req.headers.authorization, tenant);
    return true;
  }
}
