import { describe, expect, it } from 'vitest';
import { allHold, holds, render, RuleInput, triggerOf } from './engine.js';

describe('workflow conditions', () => {
  const facts = { noShows: 2, doctorName: 'Dr. Asha Rao', tags: ['VIP', 'diabetic'], mode: 'IN_PERSON', fee: null, 'field.referral_source': 'Camp' };
  it('compares numbers, text (any case), lists and emptiness', () => {
    expect(holds({ fact: 'noShows', op: 'gte', value: '2' }, facts)).toBe(true);
    expect(holds({ fact: 'noShows', op: 'lte', value: '1' }, facts)).toBe(false);
    expect(holds({ fact: 'noShows', op: 'eq', value: '2' }, facts)).toBe(true);
    expect(holds({ fact: 'doctorName', op: 'contains', value: 'asha' }, facts)).toBe(true);
    expect(holds({ fact: 'tags', op: 'eq', value: 'vip' }, facts)).toBe(true);
    expect(holds({ fact: 'tags', op: 'neq', value: 'blacklist' }, facts)).toBe(true);
    expect(holds({ fact: 'fee', op: 'not_set', value: '' }, facts)).toBe(true);
    expect(holds({ fact: 'fee', op: 'gte', value: '0' }, facts)).toBe(false);
    expect(holds({ fact: 'field.referral_source', op: 'eq', value: 'camp' }, facts)).toBe(true);
    expect(allHold([{ fact: 'noShows', op: 'gte', value: '2' }, { fact: 'mode', op: 'eq', value: 'VIDEO' }], facts)).toBe(false);
    expect(allHold([], facts)).toBe(true);
  });
  it('renders messages and maps events to triggers', () => {
    expect(render('{{patientName}} missed {{ noShows }} visits{{unknown}}', { patientName: 'Ravi', noShows: 2 })).toBe('Ravi missed 2 visits');
    expect(triggerOf('scheduling.appointment_no_show')).toEqual(['APPOINTMENT_NO_SHOW']);
  });
  it('refuses facts a trigger does not have and incomplete conditions', () => {
    const base = { name: 'x', actions: [{ type: 'TAG_PATIENT', tag: 'x' }] };
    expect(RuleInput.safeParse({ ...base, trigger: 'APPOINTMENT_NO_SHOW', conditions: [{ fact: 'noShows', op: 'gte', value: '2' }] }).success).toBe(true);
    expect(RuleInput.safeParse({ ...base, trigger: 'LAB_CRITICAL_VALUE', conditions: [{ fact: 'noShows', op: 'gte', value: '2' }] }).success).toBe(false);
    expect(RuleInput.safeParse({ ...base, trigger: 'APPOINTMENT_NO_SHOW', conditions: [{ fact: 'noShows', op: 'gte', value: 'many' }] }).success).toBe(false);
    expect(RuleInput.safeParse({ ...base, trigger: 'APPOINTMENT_NO_SHOW', actions: [{ type: 'RUN_SQL' }] }).success).toBe(false);
  });
});
