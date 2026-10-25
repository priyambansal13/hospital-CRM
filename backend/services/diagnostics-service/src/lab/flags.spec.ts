import { describe, expect, it } from 'vitest';
import { DEFAULT_TESTS } from './default-catalog.js';
import { flagValue, parametersOf, parseValue, rangeFor } from './flags.js';

const ranges = (code: string) => DEFAULT_TESTS.find((t) => t.code === code)!.ranges;

describe('reference ranges and flags', () => {
  it('uses the sex-specific range when there is one', () => {
    expect(rangeFor(ranges('CBC'), 'Haemoglobin', 'MALE')).toMatchObject({ low: 13, high: 17 });
    expect(rangeFor(ranges('CBC'), 'Haemoglobin', 'FEMALE')).toMatchObject({ low: 12, high: 15 });
    expect(flagValue('12.5', rangeFor(ranges('CBC'), 'Haemoglobin', 'MALE')).flag).toBe('LOW');
    expect(flagValue('12.5', rangeFor(ranges('CBC'), 'Haemoglobin', 'FEMALE')).flag).toBe('NORMAL');
  });
  it('critical limits come before low/high', () => {
    const glucose = rangeFor(ranges('FBS'), 'Glucose, fasting', null);
    expect(flagValue('35', glucose).flag).toBe('CRITICAL_LOW');
    expect(flagValue('65', glucose).flag).toBe('LOW');
    expect(flagValue('95', glucose).flag).toBe('NORMAL');
    expect(flagValue('180', glucose).flag).toBe('HIGH');
    expect(flagValue('452', glucose)).toMatchObject({ flag: 'CRITICAL_HIGH', valueNum: 452, unit: 'mg/dL', refLow: 70, refHigh: 99 });
    expect(flagValue('6.9', rangeFor(ranges('ELECTROLYTES'), 'Potassium', null)).flag).toBe('CRITICAL_HIGH');
  });
  it('one-sided ranges and "<"/">" values', () => {
    const hdl = rangeFor(ranges('LIPID'), 'HDL cholesterol', null);
    expect(flagValue('35', hdl).flag).toBe('LOW');
    expect(flagValue('70', hdl).flag).toBe('NORMAL');
    expect(flagValue('<0.5', rangeFor(ranges('CRP'), 'CRP', null))).toMatchObject({ flag: 'NORMAL', valueNum: 0.5 });
    expect(flagValue('5,8', rangeFor(ranges('HBA1C'), 'HbA1c', null)).flag).toBe('HIGH'); // decimal comma
  });
  it('qualitative results', () => {
    expect(flagValue('Positive', null).flag).toBe('ABNORMAL');
    expect(flagValue('NS1 antigen detected', null).flag).toBe('ABNORMAL');
    expect(flagValue('Negative', null).flag).toBe('NORMAL');
    expect(flagValue('Not detected', null).flag).toBe('NORMAL');
    expect(flagValue('No growth after 48 hours', null).flag).toBe('NORMAL');
  });
  it('tests list what they report', () => {
    expect(parametersOf(ranges('CBC'))).toEqual(['Haemoglobin', 'WBC count', 'Platelet count']);
    expect(parametersOf(ranges('DENGUE_NS1'))).toEqual(['Result']);
  });

  it('reads what the lab typed: units, thousands separators, decimal commas (review C-1)', () => {
    const glucose = rangeFor(ranges('FBS'), 'Glucose, fasting', null);
    expect(parseValue('450 mg/dL', glucose)).toEqual({ ok: true, value: '450', num: 450 });
    expect(parseValue('450mg/dl', glucose)).toMatchObject({ ok: true, num: 450 });
    expect(flagValue(parseValue('450 mg/dL', glucose).ok ? '450' : '', glucose).flag).toBe('CRITICAL_HIGH');
    const plt = rangeFor(ranges('CBC'), 'Platelet count', null);
    expect(parseValue('1,200', plt)).toMatchObject({ ok: true, num: 1200 });
    expect(parseValue('5,8', rangeFor(ranges('HBA1C'), 'HbA1c', null))).toMatchObject({ ok: true, num: 5.8 });
    expect(parseValue('>= 400', glucose)).toMatchObject({ ok: true, value: '>=400', num: 400 });
  });
  it('refuses what could hide a critical value', () => {
    const glucose = rangeFor(ranges('FBS'), 'Glucose, fasting', null);
    expect(parseValue('high', glucose)).toMatchObject({ ok: false, code: 'NOT_A_NUMBER' });
    expect(parseValue('1+', glucose)).toMatchObject({ ok: false, code: 'NOT_A_NUMBER' });
    expect(parseValue('25 mmol/L', glucose)).toMatchObject({ ok: false, code: 'UNIT_MISMATCH' });
    expect(parseValue('1,2345', glucose)).toMatchObject({ ok: false, code: 'NOT_A_NUMBER' });
    expect(parseValue('250000', rangeFor(ranges('CBC'), 'Platelet count', null))).toMatchObject({ ok: false, code: 'IMPLAUSIBLE_VALUE' });
    expect(parseValue('-5', glucose)).toMatchObject({ ok: false, code: 'IMPLAUSIBLE_VALUE' });
  });
  it('never flags an unreadable numeric value as normal; trace and plus counts are abnormal', () => {
    const glucose = rangeFor(ranges('FBS'), 'Glucose, fasting', null);
    expect(flagValue('450 mg/dL', glucose).flag).toBe('CRITICAL_HIGH');
    expect(flagValue('see comment', glucose).flag).toBe('ABNORMAL');
    expect(flagValue('Trace', null).flag).toBe('ABNORMAL');
    expect(flagValue('2+', null).flag).toBe('ABNORMAL');
    expect(flagValue('Nil', null).flag).toBe('NORMAL');
  });
});
