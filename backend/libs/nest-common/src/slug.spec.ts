import { describe, expect, it } from 'vitest';
import { slugify } from './slug.js';

describe('slugify', () => {
  it('makes readable addresses', () => {
    expect(slugify('Dr. Ananya Sharma Cardiology')).toBe('ananya-sharma-cardiology');
    expect(slugify('Dr Priya Bhatt Obstetrics & Gynecology')).toBe('priya-bhatt-obstetrics-and-gynecology');
    expect(slugify('Noida, Sector 62')).toBe('noida-sector-62');
    expect(slugify('  Gurugram — Sector 29 ')).toBe('gurugram-sector-29');
    expect(slugify('Dr. Zoë Fernández')).toBe('zoe-fernandez');
  });
  it('drops what cannot be written and keeps it short', () => {
    expect(slugify('डॉ. शर्मा')).toBe('');
    const long = slugify('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('-')).toBe(false);
  });
  it('does not take "dr" out of the middle of a name', () => {
    expect(slugify('Andrew Dr Smith')).toBe('andrew-dr-smith');
  });
});
