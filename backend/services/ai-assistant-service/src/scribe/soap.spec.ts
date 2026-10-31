import { describe, expect, it } from 'vitest';
import { devSoap } from '../llm/dev-scribe.js';
import { normaliseSoap, soapTurn } from './soap.js';

export const MOCK_CONSULT = `Doctor: Good morning. What brings you in today?
Patient: I have had a sore throat and fever for three days.
Patient: It hurts to swallow. A little cough, no breathing trouble.
Doctor: Your temperature is 38.4, pulse 96, BP 122/80. Throat is red and the tonsils are swollen.
Doctor: This looks like acute tonsillitis.
Doctor: I will start amoxicillin 500 mg three times a day for 5 days, and paracetamol 650 mg when needed for fever for 3 days.
Doctor: Let us also do a CBC.
Doctor: Drink warm fluids and rest. Come back in 5 days if you are not better.`;

describe('scribe SOAP note', () => {
  it('the dev writer turns a mock consultation into a SOAP draft', () => {
    const s = devSoap(soapTurn(MOCK_CONSULT));
    expect(s.subjective).toMatch(/sore throat and fever for three days/);
    expect(s.objective.vitals).toEqual({ bp: '122/80', pulse: 96, tempC: 38.4 });
    expect(s.objective.examination).toMatch(/tonsils are swollen/);
    expect(s.assessment).toEqual([{ description: 'Acute tonsillitis', icd10Suggestion: 'J03.9', confidence: 'HIGH' }]);
    expect(s.plan.medications).toEqual([
      { drug: 'amoxicillin', strength: '500 mg', dosage: '1-1-1', durationDays: 5, instructions: '' },
      { drug: 'paracetamol', strength: '650 mg', dosage: 'SOS', durationDays: 3, instructions: 'when needed for fever' },
    ]);
    expect(s.plan.labTests).toEqual([{ testCode: 'CBC', reason: 'acute tonsillitis' }]);
    expect(s.plan.followUpInDays).toBe(5);
    expect(s.uncertainties).toEqual([]);
  });
  it('normalises whatever the model returns', () => {
    const s = normaliseSoap({ subjective: 'x', assessment: [{ description: 'A', confidence: 'MAYBE' }, { nope: 1 }], plan: { medications: [{ drug: 'X', durationDays: 'five' }], labTests: [{ testCode: 'cbc' }] } });
    expect(s.assessment).toEqual([{ description: 'A', confidence: 'LOW' }]);
    expect(s.plan.medications[0]).toEqual({ drug: 'X', strength: '', dosage: '', durationDays: 0, instructions: '' });
    expect(s.plan.labTests[0].testCode).toBe('CBC');
    expect(s.objective).toEqual({ vitals: {}, examination: '' });
  });
});
