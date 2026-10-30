import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT = 1;

/** AES-256-GCM with the key version in front: [1 byte format][4 bytes version][12 IV][16 tag][ciphertext]. */
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
