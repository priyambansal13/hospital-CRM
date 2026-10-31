import { describe, expect, it } from 'vitest';
import { devSummary } from '../llm/dev-copilot.js';
import type { Facts } from './facts.js';
import { checkCitations, summaryTurn } from './summary.js';

const facts: Facts['facts'] = {
  T1: { date: '2026-10-31', priority: 'ROUTINE', complaint: 'Tiredness', vitals: { bp: '130/85', pulse: 82 } },
  E1: { date: '2026-08-01', doctor: 'Dr. Rao', diagnoses: ['Type 2 diabetes mellitus (E11.9), primary'] },
  P1: { date: '2026-08-01', medicines: ['Metformin 500 mg tablet 1-0-1 90 days'], coversUntil: '2026-10-30', stillCurrent: false, advice: 'Walk 30 minutes daily', followUpOn: '2026-10-31' },
  A1: { date: '2026-08-01', substance: 'Penicillin', severity: 'SEVERE', reaction: 'rash' },
  L1: { date: '2026-10-29', orderNo: 'LAB-2', values: [{ test: 'HbA1c', name: 'HbA1c', value: '7.2', unit: '%', normalRange: '4-5.6', flag: 'HIGH' }] },
  L2: { date: '2026-08-01', orderNo: 'LAB-1', values: [{ test: 'HbA1c', name: 'HbA1c', value: '6.8', unit: '%', normalRange: '4-5.6', flag: 'HIGH' }] },
};

describe('copilot citation check', () => {
  it('keeps cited lines, in section order', () => {
    const { summary, dropped } = checkCitations({ sections: [
      { title: 'Allergies', lines: [{ text: 'Penicillin: severe, rash', refs: ['A1'] }] },
      { title: 'Recent abnormal results', lines: [{ text: 'HbA1c 7.2 % (high), was 6.8 % on 2026-08-01', refs: ['L1', 'L2'] }] },
    ] }, facts);
    expect(dropped).toBe(0);
    expect(summary.sections.map((s) => s.title)).toEqual(['Allergies', 'Recent abnormal results']);
  });
  it('drops lines that cite nothing, cite a record that does not exist, or carry a number the cited records do not have', () => {
    const { summary, dropped } = checkCitations({ sections: [{ title: 'Recent abnormal results', lines: [
      { text: 'Kidney function normal', refs: [] },
      { text: 'Creatinine 1.1 mg/dL', refs: ['L9'] },
      { text: 'HbA1c 8.4 % (high)', refs: ['L1'] },
      { text: 'HbA1c 7.2 % (high)', refs: ['L1'] },
    ] }, { title: 'Made up section', lines: [{ text: 'x', refs: ['A1'] }] }] }, facts);
    expect(dropped).toBe(3);
    expect(summary.sections).toEqual([{ title: 'Recent abnormal results', lines: [{ text: 'HbA1c 7.2 % (high)', refs: ['L1'] }] }]);
  });
  it('survives a reply that is not a summary at all', () => {
    expect(checkCitations('nonsense', facts)).toEqual({ summary: { sections: [] }, dropped: 0 });
  });
});

describe('dev copilot writer', () => {
  it('writes every section from the facts, with the trend, and passes its own citation check', () => {
    const turn = summaryTurn({ patient: { id: 'p', name: 'X', age: 50, gender: 'MALE' }, appointment: { id: 'a', date: '2026-10-31', reason: null }, today: '2026-10-31', facts, sources: [] });
    const s = devSummary(turn);
    const { summary, dropped } = checkCitations(s, facts);
    expect(dropped).toBe(0);
    expect(summary.sections.map((x) => x.title)).toEqual(['Today', 'Active problems', 'Allergies', 'Recent abnormal results', 'Last visit plan']);
    expect(summary.sections.find((x) => x.title === 'Recent abnormal results')!.lines[0]).toEqual({ text: 'HbA1c 7.2 % (high, normal 4-5.6) on 2026-10-29, was 6.8 % on 2026-08-01', refs: ['L1', 'L2'] });
    // the prescription ran out yesterday: not a current medicine
    expect(summary.sections.some((x) => x.title === 'Current medicines')).toBe(false);
  });
});
