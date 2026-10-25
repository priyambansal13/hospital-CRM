import { describe, expect, it } from 'vitest';
import { allergyConflicts } from './allergy-check.js';

describe('allergy check on prescriptions', () => {
  it('direct name and drug-class matches', () => {
    expect(allergyConflicts(['Amoxicillin'], [{ substance: 'Penicillin', severity: 'SEVERE' }])).toHaveLength(1);
    expect(allergyConflicts(['Augmentin 625'], [{ substance: 'penicillins', severity: 'SEVERE' }])).toHaveLength(1);
    expect(allergyConflicts(['Ibuprofen'], [{ substance: 'NSAIDs', severity: 'MODERATE' }])).toHaveLength(1);
    expect(allergyConflicts(['Cefixime'], [{ substance: 'Cephalosporins', severity: 'MILD' }])).toHaveLength(1);
    expect(allergyConflicts(['Septran DS'], [{ substance: 'Sulfa drugs', severity: 'SEVERE' }])).toHaveLength(1);
    expect(allergyConflicts(['Paracetamol 500'], [{ substance: 'Paracetamol', severity: 'MILD' }])).toHaveLength(1);
  });
  it('no false alarm for unrelated medicines or non-drug allergies', () => {
    expect(allergyConflicts(['Paracetamol', 'Cetirizine'], [{ substance: 'Penicillin', severity: 'SEVERE' }])).toEqual([]);
    expect(allergyConflicts(['Metformin'], [{ substance: 'Peanuts', severity: 'SEVERE' }, { substance: 'Dust', severity: 'MILD' }])).toEqual([]);
  });
});
