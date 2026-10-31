import { Injectable } from '@nestjs/common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { DomainError, notFound } from '@mc/nest-common';
import { type Actor, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const SCOPES = { 'fhir:read': 'Read patients, appointments and lab reports (FHIR)', 'lis:write': 'Send lab results (LIS)' } as const;
export type Scope = keyof typeof SCOPES;
export interface KeyPrincipal { keyId: string; name: string; scopes: Scope[] }
const hash = (k: string) => createHash('sha256').update(k).digest('hex');
const toKey = (r: any) => ({ id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes as Scope[], lastUsedAt: r.last_used_at, revokedAt: r.revoked_at, createdAt: r.created_at });

/**
 * API keys (Phase 27) for the FHIR API and the LIS results callback: `mck_<prefix>_<secret>`, shown once; only a
 * SHA-256 hash is kept. Keys belong to one hospital (looked up in its own database) and carry scopes.
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly db: TenantDbRouter, private readonly entitlements: EntitlementsClient) {}

  async list() {
    const { rows } = await this.db.query('SELECT * FROM api_keys ORDER BY revoked_at NULLS FIRST, created_at DESC');
    return rows.map(toKey);
  }

  async create(actor: Actor, v: { name: string; scopes: Scope[] }) {
    const { rows: [{ n }] } = await this.db.query('SELECT count(*)::int n FROM api_keys WHERE revoked_at IS NULL');
    if (n >= 20) throw new DomainError(422, 'TOO_MANY_KEYS', 'revoke an unused key first (20 at most)');
    const prefix = randomBytes(6).toString('hex');
    const key = `mck_${prefix}_${randomBytes(24).toString('base64url')}`;
    const { rows: [r] } = await this.db.query('INSERT INTO api_keys (id, name, prefix, key_hash, scopes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [randomUUID(), v.name, prefix, hash(key), JSON.stringify(v.scopes), actor.id]);
    return { ...toKey(r), key };
  }

  async revoke(id: string) {
    const { rows: [r] } = await this.db.query('UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 RETURNING *', [id]);
    if (!r) throw notFound('API key');
    return toKey(r);
  }

  /**
   * The key on a request (Authorization: Bearer mck_…), for the current hospital, with the scope. Errors are 401
   * (no or bad key) and 403 (scope, module or feature) in FHIR-friendly wording.
   */
  async authenticate(authorization: string | undefined, scope: Scope, feature: string): Promise<KeyPrincipal> {
    const key = /^Bearer (mck_([a-f0-9]{12})_[A-Za-z0-9_-]{32})$/.exec(authorization ?? '');
    if (!key) throw new DomainError(401, 'API_KEY_REQUIRED', 'send an API key: Authorization: Bearer mck_…');
    const { rows: [r] } = await this.db.query('SELECT * FROM api_keys WHERE prefix = $1', [key[2]]);
    const ok = r && timingSafeEqual(Buffer.from(r.key_hash, 'hex'), Buffer.from(hash(key[1]), 'hex'));
    if (!ok || r.revoked_at) throw new DomainError(401, 'API_KEY_INVALID', 'this API key is not valid for this hospital (or was revoked)');
    if (!(r.scopes as string[]).includes(scope)) throw new DomainError(403, 'SCOPE_MISSING', `this API key may not ${scope === 'fhir:read' ? 'read FHIR resources' : 'send lab results'}`);
    const t = TenantContext.require();
    if ((await this.entitlements.moduleState(t.id, 'integrations')) !== 'ACTIVE') throw new DomainError(403, 'MODULE_DISABLED', 'integrations are not part of this hospital\'s plan');
    const f = (await this.entitlements.tenantFeatures(t.id)).features[feature];
    if (f && !f.enabled) throw new DomainError(403, 'FEATURE_DISABLED', `${feature} is not part of this hospital's plan`);
    if (!r.last_used_at || Date.now() - new Date(r.last_used_at).getTime() > 60_000) await this.db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [r.id]);
    return { keyId: r.id, name: r.name, scopes: r.scopes };
  }
}
