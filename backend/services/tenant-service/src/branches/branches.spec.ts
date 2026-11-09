import { describe, expect, it } from 'vitest';
import { CreateBranch, publicBranches, UpdateBranch } from './branches.controller.js';

describe('branch schemas', () => {
  it('create fills defaults', () => {
    expect(CreateBranch.parse({ name: 'Main', city: 'Pune' })).toMatchObject({ address: {}, timezone: 'Asia/Kolkata' });
  });
  it('update never injects defaults (regression: PATCH wiped the address)', () => {
    expect(UpdateBranch.parse({ active: false, version: 0 })).toEqual({ active: false, version: 0 });
  });
});

describe('publicBranches', () => {
  const row = (id: string, name: string, at: number) => ({ id, name, city: 'Noida', address: { line1: 'C-56', pincode: '201309', note: 'staff only' }, timezone: 'Asia/Kolkata', created_at: new Date(at) });
  it('gives readable addresses, unique even when two names read the same', () => {
    const out = publicBranches([row('bbbbbbbb-0000-4000-8000-000000000000', 'Noida Sector 62', 2), row('aaaaaaaa-0000-4000-8000-000000000000', 'Noida, Sector 62', 1)]);
    const slug = (id: string) => out.find((b) => b.id.startsWith(id))?.slug;
    expect(slug('aaaa')).toBe('noida-sector-62');
    expect(slug('bbbb')).toBe('noida-sector-62-bbbbbb');
    expect(out[0].address).toEqual({ line1: 'C-56', pincode: '201309' });
  });
});
