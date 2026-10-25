import { Inject, Injectable } from '@nestjs/common';
import { CONTROL_DB } from '../tokens.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

/**
 * Field-level envelope encryption (docs/HLD.md §9, MULTI-TENANCY.md §5): every hospital has its own 256-bit data key
 * (DEK), kept only wrapped by the master key (KEK). Clinical free text is AES-256-GCM encrypted with the DEK, and
 * the ciphertext is bound (AAD) to hospital + table/field + row id, so it cannot be copied to another row, field or
 * hospital and still decrypt.
 *
 * Ciphertext layout: [1 byte format = 1][4 bytes key version][12 bytes IV][16 bytes tag][ciphertext]
 * KEK: MC_MASTER_KEY (32 bytes, base64url) locally and in staging (Secret Manager); a Cloud KMS wrap/unwrap adapter
 * can replace kekWrap/kekUnwrap without changing stored data keys' use.
 *
 * Each service that encrypts keeps its own `tenant_keys` table in its own control schema (records, assistant), so a
 * service only ever holds the data keys for what it stores. Needs CoreModule `control: true`.
 */
const FORMAT = 1;

function kek(): { key: Buffer; id: string } {
  const raw = process.env.MC_MASTER_KEY;
  if (!raw) throw new Error('MC_MASTER_KEY missing (run mc configure)');
  const key = Buffer.from(raw, 'base64url');
  if (key.length !== 32) throw new Error('MC_MASTER_KEY must be 32 bytes (base64url)');
  return { key, id: `local:${createHash('sha256').update(key).digest('hex').slice(0, 12)}` };
}

export function seal(key: Buffer, plaintext: Buffer, aad: string, version: number): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  const head = Buffer.alloc(5);
  head.writeUInt8(FORMAT, 0);
  head.writeUInt32BE(version, 1);
  return Buffer.concat([head, iv, c.getAuthTag(), body]);
}

export function open(keyFor: (version: number) => Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.readUInt8(0) !== FORMAT) throw new Error('unknown ciphertext format');
  const version = sealed.readUInt32BE(1);
  const d = createDecipheriv('aes-256-gcm', keyFor(version), sealed.subarray(5, 17));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(17, 33));
  return Buffer.concat([d.update(sealed.subarray(33)), d.final()]);
}

export const keyVersionOf = (sealed: Buffer) => sealed.readUInt32BE(1);

@Injectable()
export class FieldCrypto {
  private readonly keys = new Map<string, Map<number, Buffer>>();
  private readonly current = new Map<string, number>();

  constructor(@Inject(CONTROL_DB) private readonly control: pg.Pool) {}

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
      const k = kek();
      const dek = randomBytes(32);
      // version 1 is created once; concurrent first uses converge on the stored one
      await this.control.query(`INSERT INTO tenant_keys (tenant_id, version, wrapped_dek, kek_id) VALUES ($1, 1, $2, $3) ON CONFLICT DO NOTHING`,
        [tenantId, seal(k.key, dek, `dek:${tenantId}`, 0), k.id]);
      const { rows } = await this.control.query('SELECT max(version) AS v FROM tenant_keys WHERE tenant_id = $1', [tenantId]);
      v = Number(rows[0].v);
      this.current.set(tenantId, v);
    }
    return { version: v, key: await this.keyVersion(tenantId, v) };
  }

  private async keyVersion(tenantId: string, version: number): Promise<Buffer> {
    const cached = this.keys.get(tenantId)?.get(version);
    if (cached) return cached;
    const { rows } = await this.control.query('SELECT wrapped_dek FROM tenant_keys WHERE tenant_id = $1 AND version = $2', [tenantId, version]);
    if (!rows[0]) throw new Error(`no data key v${version} for this hospital`);
    const dek = open(() => kek().key, rows[0].wrapped_dek, `dek:${tenantId}`);
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
}
