import { createHash } from 'node:crypto';
import { open, seal } from './seal.js';

/**
 * Who wraps the hospitals' data keys (review A-5 / wave 4 "KMS"). The data keys (DEKs) never leave a service
 * unwrapped except in memory; the wrapping key (KEK) is either:
 *  - local: MC_MASTER_KEY (32 bytes, base64url), the default locally and in staging. MC_MASTER_KEY_PREVIOUS (comma
 *    separated) keeps older master keys readable while their data keys are re-wrapped (KEK rotation).
 *  - gcp-kms: a Cloud KMS key (KMS_KEY_NAME=projects/…/locations/…/keyRings/…/cryptoKeys/…), called with the pod's
 *    workload identity. The master key never leaves KMS. Built against the KMS REST API; not yet run against GCP.
 * Every stored data key records the `kek_id` that wrapped it, so keys wrapped by different KEKs can coexist.
 */
export interface KeyWrapper {
  /** id of the KEK new data keys are wrapped with */
  readonly id: string;
  wrap(dek: Buffer, aad: string): Promise<Buffer>;
  /** unwrap a data key wrapped by `kekId` (this KEK or one it still knows) */
  unwrap(wrapped: Buffer, aad: string, kekId: string): Promise<Buffer>;
}

const localId = (key: Buffer) => `local:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
const parseKey = (raw: string, name: string) => {
  const key = Buffer.from(raw.trim(), 'base64url');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes (base64url)`);
  return key;
};

export class LocalKeyWrapper implements KeyWrapper {
  private readonly current: Buffer;
  private readonly known = new Map<string, Buffer>();
  readonly id: string;
  constructor(master = process.env.MC_MASTER_KEY, previous = process.env.MC_MASTER_KEY_PREVIOUS) {
    if (!master) throw new Error('MC_MASTER_KEY missing (run mc configure)');
    this.current = parseKey(master, 'MC_MASTER_KEY');
    this.id = localId(this.current);
    this.known.set(this.id, this.current);
    for (const p of (previous ?? '').split(',').filter(Boolean)) { const k = parseKey(p, 'MC_MASTER_KEY_PREVIOUS'); this.known.set(localId(k), k); }
  }
  async wrap(dek: Buffer, aad: string) { return seal(this.current, dek, aad, 0); }
  async unwrap(wrapped: Buffer, aad: string, kekId: string) {
    const k = this.known.get(kekId);
    if (!k) throw new Error(`data key wrapped by an unknown master key (${kekId}): add it to MC_MASTER_KEY_PREVIOUS`);
    return open(() => k, wrapped, aad);
  }
}

/** Cloud KMS (symmetric encrypt/decrypt), token from the GKE metadata server (workload identity). */
export class GcpKmsKeyWrapper implements KeyWrapper {
  readonly id: string;
  private token?: { value: string; exp: number };
  constructor(private readonly keyName = process.env.KMS_KEY_NAME ?? '', private readonly fetchFn: typeof fetch = fetch, private readonly local?: KeyWrapper) {
    if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(keyName)) throw new Error('KMS_KEY_NAME must be projects/…/locations/…/keyRings/…/cryptoKeys/…');
    this.id = `gcpkms:${keyName}`;
  }
  private async accessToken() {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const r = await this.fetchFn('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
    if (!r.ok) throw new Error(`metadata token ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }
  private async call(op: 'encrypt' | 'decrypt', key: string, body: Record<string, string>) {
    const r = await this.fetchFn(`https://cloudkms.googleapis.com/v1/${key}:${op}`, { method: 'POST', headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Cloud KMS ${op} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as { ciphertext?: string; plaintext?: string };
  }
  async wrap(dek: Buffer, aad: string) {
    const j = await this.call('encrypt', this.keyName, { plaintext: dek.toString('base64'), additionalAuthenticatedData: Buffer.from(aad).toString('base64') });
    return Buffer.from(j.ciphertext!, 'base64');
  }
  async unwrap(wrapped: Buffer, aad: string, kekId: string) {
    // data keys wrapped locally before the move to KMS stay readable until re-wrapped
    if (kekId.startsWith('local:')) { if (!this.local) throw new Error('a locally wrapped data key: keep MC_MASTER_KEY until `mc keys rewrap` has run'); return this.local.unwrap(wrapped, aad, kekId); }
    if (!kekId.startsWith('gcpkms:')) throw new Error(`unknown key wrapper ${kekId}`);
    const j = await this.call('decrypt', kekId.slice('gcpkms:'.length), { ciphertext: wrapped.toString('base64'), additionalAuthenticatedData: Buffer.from(aad).toString('base64') });
    return Buffer.from(j.plaintext!, 'base64');
  }
}

/** KEY_WRAPPER=local (default) | gcp-kms; read when first used (service .env loads after imports). */
export function keyWrapperFromEnv(): KeyWrapper {
  const mode = process.env.KEY_WRAPPER ?? 'local';
  if (mode === 'local') return new LocalKeyWrapper();
  if (mode === 'gcp-kms') return new GcpKmsKeyWrapper(process.env.KMS_KEY_NAME, fetch, process.env.MC_MASTER_KEY ? new LocalKeyWrapper() : undefined);
  throw new Error(`KEY_WRAPPER must be local or gcp-kms (got "${mode}")`);
}
