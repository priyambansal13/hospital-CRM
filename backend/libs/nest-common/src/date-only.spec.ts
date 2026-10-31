import { describe, expect, it } from 'vitest';
import { dateOnly } from './date-only.js';

describe('dateOnly', () => {
  it('keeps the calendar day node-pg gave (local midnight), in any time zone', () => {
    expect(dateOnly(new Date(2026, 9, 31))).toBe('2026-10-31');
    expect(dateOnly('2026-10-31')).toBe('2026-10-31');
    expect(dateOnly(null)).toBeNull();
  });
});
