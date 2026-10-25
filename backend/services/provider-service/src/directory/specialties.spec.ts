import { describe, expect, it } from 'vitest';
import { CreateDoctor, UpdateDoctor } from './doctors.controller.js';
import { toCode } from './specialties.controller.js';

describe('specialty codes', () => {
  it('are derived from names, keeping digits so similar names do not collide', () => {
    expect(toCode('Obstetrics & Gynecology')).toBe('OBSTETRICS_AND_GYNECOLOGY');
    expect(toCode('Sleep Medicine 2')).toBe('SLEEP_MEDICINE_2');
    expect(toCode('3D Imaging')).toBe('D_IMAGING');
  });
});

describe('doctor schemas', () => {
  it('create applies defaults and lowercases email; update injects none', () => {
    const c = CreateDoctor.parse({ name: 'Dr. A', email: 'A@X.test', registrationNo: 'R-1', specialties: [{ code: 'CARDIOLOGY' }], branches: [{ branchId: '00000000-0000-4000-8000-000000000001', fee: 500 }] });
    expect(c).toMatchObject({ email: 'a@x.test', languages: ['en'], consultModes: ['IN_PERSON'], gender: null });
    expect(UpdateDoctor.parse({ bio: null, version: 3 })).toEqual({ bio: null, version: 3 });
  });
});
