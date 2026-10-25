import { describe, expect, it } from 'vitest';
import { CreateBranch, UpdateBranch } from './branches.controller.js';

describe('branch schemas', () => {
  it('create fills defaults', () => {
    expect(CreateBranch.parse({ name: 'Main', city: 'Pune' })).toMatchObject({ address: {}, timezone: 'Asia/Kolkata' });
  });
  it('update never injects defaults (regression: PATCH wiped the address)', () => {
    expect(UpdateBranch.parse({ active: false, version: 0 })).toEqual({ active: false, version: 0 });
  });
});
