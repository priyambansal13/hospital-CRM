import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GcpKmsKeyWrapper, keyWrapperFromEnv, LocalKeyWrapper } from './key-wrapper.js';

const k = () => randomBytes(32).toString('base64url');

describe('key wrappers (wave 4: KMS)', () => {
  it('local: wraps and unwraps; a data key from a previous master key stays readable (KEK rotation)', async () => {
    const [oldKey, newKey] = [k(), k()];
    const dek = randomBytes(32);
    const old = new LocalKeyWrapper(oldKey);
    const wrapped = await old.wrap(dek, 'dek:t1');
    const rotated = new LocalKeyWrapper(newKey, oldKey);
    expect(rotated.id).not.toBe(old.id);
    expect(await rotated.unwrap(wrapped, 'dek:t1', old.id)).toEqual(dek);
    await expect(new LocalKeyWrapper(newKey).unwrap(wrapped, 'dek:t1', old.id)).rejects.toThrow(/unknown master key/);
    await expect(rotated.unwrap(wrapped, 'dek:t2', old.id)).rejects.toThrow(); // bound to the hospital
  });

  it('gcp-kms: calls encrypt/decrypt with the AAD and the workload token', async () => {
    const calls: { url: string; body?: any }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('metadata')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      const b = JSON.parse(String(init!.body));
      return new Response(JSON.stringify(url.endsWith(':encrypt') ? { ciphertext: Buffer.from(`X${b.plaintext}`).toString('base64') } : { plaintext: Buffer.from(b.ciphertext, 'base64').toString().slice(1) }));
    }) as typeof fetch;
    const name = 'projects/p/locations/asia-south1/keyRings/r/cryptoKeys/dek';
    const w = new GcpKmsKeyWrapper(name, fake);
    const dek = randomBytes(32);
    const wrapped = await w.wrap(dek, 'dek:t1');
    expect(await w.unwrap(wrapped, 'dek:t1', w.id)).toEqual(dek);
    const enc = calls.find((c) => c.url.endsWith(':encrypt'))!;
    expect(enc.url).toBe(`https://cloudkms.googleapis.com/v1/${name}:encrypt`);
    expect(Buffer.from(enc.body.additionalAuthenticatedData, 'base64').toString()).toBe('dek:t1');
    expect(calls.filter((c) => c.url.includes('metadata'))).toHaveLength(1); // token cached
    expect(() => new GcpKmsKeyWrapper('not-a-key', fake)).toThrow(/KMS_KEY_NAME/);
  });

  it('gcp-kms reads keys wrapped locally before the move until they are re-wrapped', async () => {
    const local = new LocalKeyWrapper(k());
    const dek = randomBytes(32);
    const w = new GcpKmsKeyWrapper('projects/p/locations/l/keyRings/r/cryptoKeys/c', (async () => new Response('{}')) as typeof fetch, local);
    expect(await w.unwrap(await local.wrap(dek, 'dek:t'), 'dek:t', local.id)).toEqual(dek);
  });

  it('KEY_WRAPPER picks the wrapper', () => {
    const env = { ...process.env };
    process.env.MC_MASTER_KEY = k();
    process.env.KEY_WRAPPER = 'local';
    expect(keyWrapperFromEnv()).toBeInstanceOf(LocalKeyWrapper);
    process.env.KEY_WRAPPER = 'vault';
    expect(() => keyWrapperFromEnv()).toThrow(/local or gcp-kms/);
    process.env = env;
  });
});
