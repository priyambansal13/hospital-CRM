import { describe, expect, it } from 'vitest';
import { allergyGroups, checkPrescription, matchDrug, needsOverride } from './safety.js';

describe('formulary matching', () => {
  it('finds generics and brands inside what doctors write', () => {
    expect(matchDrug('Tab. Augmentin 625')?.code).toBe('AMOXICLAV');
    expect(matchDrug('Amoxicillin + Clavulanic acid 625 mg')?.code).toBe('AMOXICLAV');
    expect(matchDrug('amoxicillin 500 mg')?.code).toBe('AMOXICILLIN');
    expect(matchDrug('Dolo 650')?.code).toBe('PARACETAMOL');
    expect(matchDrug('Unknownomycin')).toBeNull();
  });
  it('reads allergy words into groups', () => {
    expect(allergyGroups('Sulfa drugs')).toEqual(['SULFONAMIDE']);
    expect(allergyGroups('Penicillin')).toEqual(['PENICILLIN']);
  });
});

describe('prescription safety', () => {
  it('blocks a drug from the allergy group, cautions a cross-reactive one', () => {
    const r = checkPrescription({ items: [{ drugName: 'Augmentin 625' }, { drugName: 'Cefixime 200 mg' }, { drugName: 'Paracetamol 650' }], allergies: [{ substance: 'Penicillin' }] });
    expect(r.allergies).toEqual([
      expect.objectContaining({ drug: 'Augmentin 625', level: 'BLOCK' }),
      expect.objectContaining({ drug: 'Cefixime 200 mg', level: 'CAUTION' }),
    ]);
    expect(needsOverride(r)).toBe(true);
  });
  it('finds interactions inside the prescription and with current medicines, and same-class duplicates', () => {
    const r = checkPrescription({ items: [{ drugName: 'Ibuprofen 400' }, { drugName: 'Diclofenac 50' }, { drugName: 'Tramadol 50' }], allergies: [], current: [{ drugName: 'Warfarin 5 mg' }, { drugName: 'Sertraline 50 mg' }] });
    expect(r.interactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ a: 'Ibuprofen 400', b: 'Warfarin 5 mg', severity: 'MAJOR', withCurrent: true }),
      expect.objectContaining({ a: 'Tramadol 50', b: 'Sertraline 50 mg', severity: 'MAJOR', withCurrent: true }),
    ]));
    expect(r.duplicates).toEqual([{ a: 'Ibuprofen 400', b: 'Diclofenac 50', drugClass: 'NSAID' }]);
  });
  it('a clean prescription needs no override; unknown drugs are listed, not guessed', () => {
    const r = checkPrescription({ items: [{ drugName: 'Metformin 500' }, { drugName: 'Herbal tonic' }], allergies: [{ substance: 'Sulfa' }], current: [{ drugName: 'Amlodipine 5' }] });
    expect(needsOverride(r)).toBe(false);
    expect(r.unmatched).toEqual(['Herbal tonic']);
  });
});
