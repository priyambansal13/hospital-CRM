import type { RefRange } from './default-catalog.js';

export type Flag = 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL_LOW' | 'CRITICAL_HIGH' | 'ABNORMAL';
export interface Flagged { flag: Flag; valueNum: number | null; refLow: number | null; refHigh: number | null; unit: string | null }

/** The reference range for a parameter: the patient's sex if the test has sex-specific ranges, else the general one. */
export function rangeFor(ranges: RefRange[], param: string, sex: string | null): RefRange | null {
  const forParam = ranges.filter((r) => r.param === param);
  const s = sex === 'MALE' ? 'M' : sex === 'FEMALE' ? 'F' : null;
  return forParam.find((r) => r.sex && r.sex === s) ?? forParam.find((r) => !r.sex) ?? forParam[0] ?? null;
}

/** Parameters a test reports: from its reference ranges; tests without ranges report one qualitative "Result". */
export const parametersOf = (ranges: RefRange[]) => (ranges.length ? [...new Set(ranges.map((r) => r.param))] : ['Result']);

const NEGATIVE = /\b(negative|non[- ]?reactive|not detected|absent|nil|no growth|normal)\b/i;
// "Trace", "1+".."4+", "++": present in some amount, so not normal
const POSITIVE = /\b(positive|reactive|detected|present|seen|growth|trace)\b|\d\s*\+|\+\+|^\+$/i;

/** A parameter with numeric limits must be reported as a number (anything else could hide a critical value). */
export const isNumeric = (range: RefRange | null) =>
  !!range && [range.low, range.high, range.criticalLow, range.criticalHigh].some((x) => typeof x === 'number');

const unitKey = (u: string) => u.toLowerCase().replace(/\s+/g, '').replace(/μ/g, 'µ').replace(/\^3|3(?=\/)/g, '³');

export type Parsed = { ok: true; value: string; num: number | null } | { ok: false; code: string; message: string };

/**
 * Read what the lab typed, before it is stored and flagged (docs/ROLE-FLOWS-AND-GAPS.md C-1). For numeric parameters:
 * - "450", "450 mg/dL" (the expected unit is accepted and dropped), "<0.5", ">= 400";
 * - thousands separators: "1,200", "1,20,000"; a decimal comma: "5,8" → 5.8;
 * - refused: text ("high", "1+"), a different unit ("450 mmol/L" for mg/dL), and values far outside anything
 *   plausible (usually a unit mix-up, e.g. platelets typed as 250000 instead of 250 ×10³/µL).
 * Qualitative parameters keep their text.
 */
export function parseValue(raw: string, range: RefRange | null): Parsed {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!isNumeric(range)) return { ok: true, value: text, num: text.match(/^[<>]?=?\s*-?\d+(\.\d+)?$/) ? Number(text.replace(/[<>=\s]/g, '')) : null };
  const m = text.match(/^([<>]=?)?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(.*)$/);
  if (!m) return { ok: false, code: 'NOT_A_NUMBER', message: `enter a number${range?.unit ? ` in ${range.unit}` : ''}` };
  const [, cmp = '', digits, rest] = m;
  let n: number;
  if (!digits.includes(',')) n = Number(digits);
  else if (/^-?\d{1,3}(,\d{2})*,\d{3}(\.\d+)?$/.test(digits)) n = Number(digits.replace(/,/g, '')); // 1,200 / 1,20,000
  else if (/^-?\d+,\d{1,2}$/.test(digits)) n = Number(digits.replace(',', '.')); // 5,8
  else return { ok: false, code: 'NOT_A_NUMBER', message: `"${digits}" is not a clear number: use a dot for decimals` };
  if (!Number.isFinite(n)) return { ok: false, code: 'NOT_A_NUMBER', message: 'enter a number' };
  if (rest && !/[a-zµμ%/³]/i.test(rest)) return { ok: false, code: 'NOT_A_NUMBER', message: `enter a number${range?.unit ? ` in ${range.unit}` : ''} (not "${text}")` };
  if (rest && unitKey(rest) !== unitKey(range!.unit || '')) {
    return { ok: false, code: 'UNIT_MISMATCH', message: `this is reported in ${range!.unit || 'no unit'}: enter the number only${rest ? ` (not "${rest}")` : ''}` };
  }
  const floor = Math.min(range!.low ?? 0, range!.criticalLow ?? 0, 0);
  const ceiling = Math.max(range!.high ?? 0, range!.criticalHigh ?? 0);
  if (n < floor) return { ok: false, code: 'IMPLAUSIBLE_VALUE', message: `${n} is below anything possible for this test: check the value` };
  if (ceiling > 0 && n > ceiling * 50) return { ok: false, code: 'IMPLAUSIBLE_VALUE', message: `${n} ${range!.unit} is far above anything plausible: check the value and the unit` };
  return { ok: true, value: `${cmp}${n}`, num: n };
}

/**
 * Flag a value against its range. Numbers: critical limits first, then low/high. Text ("Positive", "No growth"):
 * anything that reads as positive is ABNORMAL. Values like "<0.5" or ">400" are read as the number. A value that
 * cannot be read for a numeric parameter is ABNORMAL, never NORMAL (entry refuses it; this is the safety net).
 */
export function flagValue(value: string, range: RefRange | null): Flagged {
  const unit = range?.unit || null;
  const refLow = range?.low ?? null;
  const refHigh = range?.high ?? null;
  const p = parseValue(value, range);
  if (!isNumeric(range)) {
    const abnormal = POSITIVE.test(value) && !NEGATIVE.test(value);
    return { flag: abnormal ? 'ABNORMAL' : 'NORMAL', valueNum: p.ok ? p.num : null, refLow, refHigh, unit };
  }
  if (!p.ok || p.num === null) return { flag: 'ABNORMAL', valueNum: null, refLow, refHigh, unit };
  const n = p.num;
  let flag: Flag = 'NORMAL';
  if (range?.criticalLow != null && n < range.criticalLow) flag = 'CRITICAL_LOW';
  else if (range?.criticalHigh != null && n > range.criticalHigh) flag = 'CRITICAL_HIGH';
  else if (refLow != null && n < refLow) flag = 'LOW';
  else if (refHigh != null && n > refHigh) flag = 'HIGH';
  return { flag, valueNum: n, refLow, refHigh, unit };
}

export const isCritical = (f: Flag) => f === 'CRITICAL_LOW' || f === 'CRITICAL_HIGH';
export const isAbnormal = (f: Flag) => f !== 'NORMAL';
