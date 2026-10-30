import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { CONTROL_DB } from '../tokens.js';
import { type KeyWrapper, keyWrapperFromEnv } from './key-wrapper.js';
import { keyVersionOf, open, seal } from './seal.js';

export { keyVersionOf, open, seal } from './seal.js';

/**
 * Field-level envelope encryption (docs/HLD.md §9, MULTI-TENANCY.md §5): every hospital has its own 256-bit data key
 * (DEK), kept only wrapped by the master key (KEK). Clinical free text is AES-256-GCM encrypted with the DEK, and
 * the ciphertext is bound (AAD) to hospital + table/field + row id, so it cannot be copied to another row, field or
 * hospital and still decrypt.
 *
 * Ciphertext layout: [1 byte format = 1][4 bytes key version][12 bytes IV][16 bytes tag][ciphertext]
 * KEK: a KeyWrapper (key-wrapper.ts): MC_MASTER_KEY locally and in staging, or Cloud KMS (KEY_WRAPPER=gcp-kms).
 * rotate() adds a data key version; rewrapAll() moves every data key to the current KEK.
 *
 * Each service that encrypts keeps its own `tenant_keys` table in its own control schema (records, assistant), so a
 * service only ever holds the data keys for what it stores. Needs CoreModule `control: true`.
 */



@Injectable()
export class FieldCrypto {
  private readonly keys = new Map<string, Map<number, Buffer>>();
  private readonly current = new Map<string, number>();
  private wrapperCache?: KeyWrapper;

  constructor(@Inject(CONTROL_DB) private readonly control: pg.Pool) {}

  private get wrapper() { return (this.wrapperCache ??= keyWrapperFromEnv()); }

  /** Provisioning: create the hospital's data key now (idempotent). */
  async ensureKey(tenantId: string) {
    await this.currentKey(tenantId);
  }

  async hasKey(tenantId: string) {
    return !!(await this.control.query('SELECT 1 FROM tenant_keys WHERE tenant_id = $1 LIMIT 1', [tenantId])).rows[0];
  }

  /** The hospital's current data key (created on first use). */
  private async currentKey(tenantId: string): Promise<{ version: number; key: Buffer }> {
    let v = this.current.get(tenantId);
    if (v === undefined) {
      const dek = randomBytes(32);
      // version 1 is created once; concurrent first uses converge on the stored one
      await this.control.query(`INSERT INTO tenant_keys (tenant_id, version, wrapped_dek, kek_id) VALUES ($1, 1, $2, $3) ON CONFLICT DO NOTHING`,
        [tenantId, await this.wrapper.wrap(dek, `dek:${tenantId}`), this.wrapper.id]);
      const { rows } = await this.control.query('SELECT max(version) AS v FROM tenant_keys WHERE tenant_id = $1', [tenantId]);
      v = Number(rows[0].v);
      this.current.set(tenantId, v);
    }
    return { version: v, key: await this.keyVersion(tenantId, v) };
  }

  private async keyVersion(tenantId: string, version: number): Promise<Buffer> {
    const cached = this.keys.get(tenantId)?.get(version);
    if (cached) return cached;
    const { rows } = await this.control.query('SELECT wrapped_dek, kek_id FROM tenant_keys WHERE tenant_id = $1 AND version = $2', [tenantId, version]);
    if (!rows[0]) throw new Error(`no data key v${version} for this hospital`);
    const dek = await this.wrapper.unwrap(rows[0].wrapped_dek, `dek:${tenantId}`, rows[0].kek_id);
    if (!this.keys.has(tenantId)) this.keys.set(tenantId, new Map());
    this.keys.get(tenantId)!.set(version, dek);
    return dek;
  }

  async encrypt(tenantId: string, aad: string, text: string | null | undefined): Promise<Buffer | null> {
    if (text == null || text === '') return null;
    const { version, key } = await this.currentKey(tenantId);
    return seal(key, Buffer.from(text, 'utf8'), `${tenantId}:${aad}`, version);
  }

  async decrypt(tenantId: string, aad: string, sealed: Buffer | null): Promise<string | null> {
    if (!sealed) return null;
    const key = await this.keyVersion(tenantId, keyVersionOf(sealed));
    return open(() => key, sealed, `${tenantId}:${aad}`).toString('utf8');
  }

  /**
   * Data key rotation: a new version for this hospital; new writes use it, older ciphertexts keep decrypting with the
   * version recorded in them (re-encrypting old rows is not needed for confidentiality going forward).
   */
  async rotate(tenantId: string) {
    const dek = randomBytes(32);
    const { rows: [r] } = await this.control.query(
      `INSERT INTO tenant_keys (tenant_id, version, wrapped_dek, kek_id) SELECT $1, coalesce(max(version), 0) + 1, $2, $3 FROM tenant_keys WHERE tenant_id = $1 RETURNING version`,
      [tenantId, await this.wrapper.wrap(dek, `dek:${tenantId}`), this.wrapper.id]);
    this.current.set(tenantId, r.version);
    this.keys.get(tenantId)?.set(r.version, dek);
    return { tenantId, version: r.version as number };
  }

  /**
   * KEK rotation: every data key not wrapped by the current master key is re-wrapped with it (the data keys and all
   * ciphertexts stay the same). Afterwards the old master key can be retired.
   */
  async rewrapAll() {
    const { rows } = await this.control.query('SELECT tenant_id, version, wrapped_dek, kek_id FROM tenant_keys WHERE kek_id <> $1', [this.wrapper.id]);
    for (const r of rows) {
      const dek = await this.wrapper.unwrap(r.wrapped_dek, `dek:${r.tenant_id}`, r.kek_id);
      await this.control.query('UPDATE tenant_keys SET wrapped_dek = $3, kek_id = $4 WHERE tenant_id = $1 AND version = $2', [r.tenant_id, r.version, await this.wrapper.wrap(dek, `dek:${r.tenant_id}`), this.wrapper.id]);
    }
    return { rewrapped: rows.length, kek: this.wrapper.id };
  }
}
