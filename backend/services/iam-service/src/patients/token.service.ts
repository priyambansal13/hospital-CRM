import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CONTROL_DB, REDIS, type Redis } from '@mc/nest-common';
import { withTx } from '@mc/tenancy';
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from 'jose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_S = 30 * 24 * 3600;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface RefreshRecord { personId: string; tenantId: string; family: string }

/**
 * Patient tokens (Keycloak handles staff). ES256 access tokens for 15 min with the tenant baked in (`tid`), plus
 * opaque rotating refresh tokens with reuse detection: presenting an already-rotated token revokes the family.
 */
@Injectable()
export class TokenService implements OnModuleInit {
  private signingKey?: { kid: string; key: CryptoKey | Uint8Array };
  readonly issuer = process.env.PATIENT_TOKEN_ISSUER ?? 'http://localhost:4402/patient-auth';

  constructor(@Inject(CONTROL_DB) private readonly control: pg.Pool, @Inject(REDIS) private readonly redis: Redis) {}

  async onModuleInit() {
    const row = await withTx(this.control, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('iam:signing-key'))");
      const { rows } = await c.query('SELECT kid, private_jwk FROM signing_keys WHERE active ORDER BY created_at DESC LIMIT 1');
      if (rows[0]) return rows[0];
      const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
      const kid = randomUUID();
      const priv = { ...(await exportJWK(privateKey)), kid, alg: 'ES256' };
      const pub = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
      await c.query('INSERT INTO signing_keys (kid, private_jwk, public_jwk) VALUES ($1,$2,$3)', [kid, priv, pub]);
      return { kid, private_jwk: priv };
    });
    this.signingKey = { kid: row.kid, key: await importJWK(row.private_jwk as JWK, 'ES256') };
  }

  async jwks() {
    const { rows } = await this.control.query('SELECT public_jwk FROM signing_keys WHERE active');
    return { keys: rows.map((r) => r.public_jwk) };
  }

  async issue(personId: string, tenantId: string, family: string = randomUUID()) {
    const accessToken = await new SignJWT({ tid: tenantId, typ: 'patient' })
      .setProtectedHeader({ alg: 'ES256', kid: this.signingKey!.kid })
      .setIssuer(this.issuer).setAudience('mc-api').setSubject(personId)
      .setIssuedAt().setExpirationTime(`${ACCESS_TTL_S}s`).setJti(randomUUID())
      .sign(this.signingKey!.key);
    const refreshToken = randomBytes(32).toString('base64url');
    const rec: RefreshRecord = { personId, tenantId, family };
    await this.redis.set(`rt:${sha(refreshToken)}`, JSON.stringify(rec), 'EX', REFRESH_TTL_S);
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_S, tokenType: 'Bearer' };
  }

  /** Rotate a refresh token. Returns undefined when invalid, expired, revoked or reused. */
  async rotate(refreshToken: string, tenantId: string) {
    const h = sha(refreshToken);
    const raw = await this.redis.getdel(`rt:${h}`);
    if (!raw) {
      const reusedFamily = await this.redis.get(`rt-used:${h}`);
      if (reusedFamily) await this.redis.set(`rt-revoked:${reusedFamily}`, '1', 'EX', REFRESH_TTL_S);
      return undefined;
    }
    const rec = JSON.parse(raw) as RefreshRecord;
    if (rec.tenantId !== tenantId || (await this.redis.exists(`rt-revoked:${rec.family}`))) return undefined;
    await this.redis.set(`rt-used:${h}`, rec.family, 'EX', REFRESH_TTL_S);
    return this.issue(rec.personId, rec.tenantId, rec.family);
  }

  async revoke(refreshToken: string) {
    const raw = await this.redis.getdel(`rt:${sha(refreshToken)}`);
    if (raw) await this.redis.set(`rt-revoked:${(JSON.parse(raw) as RefreshRecord).family}`, '1', 'EX', REFRESH_TTL_S);
  }
}
