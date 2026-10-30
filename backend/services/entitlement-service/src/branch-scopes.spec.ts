import { describe, expect, it } from 'vitest';
import { scopesOf } from './branch-scopes.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const active = new Set(['appointment:checkin:branch', 'invoice:read:branch', 'staff:read:tenant', 'schedule:manage:own']);

describe('branch scopes (review B-1)', () => {
  it('a role given at one branch limits its ":branch" permissions to that branch', () => {
    const r = scopesOf([{ grants_all: false, perms: ['appointment:checkin:branch', 'staff:read:tenant'], branch_id: A }], active);
    expect(r.branchScopes).toEqual({ 'appointment:checkin:branch': [A] });
    expect(r.branchIds).toEqual([A]);
  });

  it('grants at two branches add up', () => {
    const r = scopesOf([
      { grants_all: false, perms: ['appointment:checkin:branch'], branch_id: B },
      { grants_all: false, perms: ['appointment:checkin:branch', 'invoice:read:branch'], branch_id: A },
    ], active);
    expect(r.branchScopes).toEqual({ 'appointment:checkin:branch': [A, B], 'invoice:read:branch': [A] });
    expect(r.branchIds).toEqual([A, B]);
  });

  it('one hospital-wide grant of a permission makes it hospital-wide', () => {
    const r = scopesOf([
      { grants_all: false, perms: ['appointment:checkin:branch'], branch_id: A },
      { grants_all: false, perms: ['appointment:checkin:branch'], branch_id: null },
    ], active);
    expect(r.branchScopes).toEqual({});
    expect(r.branchIds).toBeNull();
  });

  it('a hospital admin given at a branch is limited there; permissions outside the plan are ignored', () => {
    const r = scopesOf([{ grants_all: true, perms: [], branch_id: A }], active);
    expect(r.branchScopes).toEqual({ 'appointment:checkin:branch': [A], 'invoice:read:branch': [A] });
    expect(scopesOf([{ grants_all: false, perms: ['refund:create:branch'], branch_id: A }], active).branchScopes).toEqual({});
  });
});
