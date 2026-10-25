import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyVersionOf, open, seal } from './field-crypto.js';

const key = randomBytes(32);
const text = 'Chest pain on exertion since 2 weeks; ECG normal.';

describe('field encryption (AES-256-GCM, bound to its row)', () => {
  it('round-trips and records the key version', () => {
    const s = seal(key, Buffer.from(text), 't1:encounters.notes:row1', 3);
    expect(keyVersionOf(s)).toBe(3);
    expect(open(() => key, s, 't1:encounters.notes:row1').toString()).toBe(text);
  });
  it('ciphertext does not contain the text, and the same text encrypts differently each time', () => {
    const a = seal(key, Buffer.from(text), 'x', 1);
    const b = seal(key, Buffer.from(text), 'x', 1);
    expect(a.includes(Buffer.from('Chest pain'))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });
  it('copied to another row, field or hospital it no longer decrypts', () => {
    const s = seal(key, Buffer.from(text), 't1:encounters.notes:row1', 1);
    for (const aad of ['t1:encounters.notes:row2', 't1:encounters.complaint:row1', 't2:encounters.notes:row1']) {
      expect(() => open(() => key, s, aad)).toThrow();
    }
  });
  it('a flipped bit or a wrong key is detected', () => {
    const s = seal(key, Buffer.from(text), 'x', 1);
    const t = Buffer.from(s);
    t[t.length - 1] ^= 1;
    expect(() => open(() => key, t, 'x')).toThrow();
    expect(() => open(() => randomBytes(32), s, 'x')).toThrow();
  });
});
