import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_WINDOWS, DEFAULT_PACKAGES, DEFAULT_TESTS } from './default-catalog.js';
import { preparationFor } from './lab.service.js';

describe('lab preparation', () => {
  it('takes the longest fast once and keeps other instructions', () => {
    expect(preparationFor([{ preparation: 'Fast for 8–10 hours (water is fine)', fasting_hours: 8 }, { preparation: 'Fast for 10–12 hours (water is fine)', fasting_hours: 10 },
      { preparation: 'First morning sample preferred; collect midstream', fasting_hours: null }])).toBe('Fast for 10 hours before the test (water is fine). First morning sample preferred; collect midstream');
    expect(preparationFor([{ preparation: null, fasting_hours: null }])).toBeNull();
  });
});

describe('template catalog', () => {
  it('every package test exists, codes are unique, prices are positive, packages cost less than their tests', () => {
    const codes = new Set(DEFAULT_TESTS.map((t) => t.code));
    expect(codes.size).toBe(DEFAULT_TESTS.length);
    for (const t of DEFAULT_TESTS) expect(t.price).toBeGreaterThan(0);
    for (const p of DEFAULT_PACKAGES) {
      for (const c of p.tests) expect(codes.has(c), `${p.code} → ${c}`).toBe(true);
      const worth = p.tests.reduce((s, c) => s + DEFAULT_TESTS.find((t) => t.code === c)!.price, 0);
      expect(p.price, p.code).toBeLessThan(worth);
    }
  });
});

describe('home collection defaults', () => {
  it('visits every day of the week, early (fasting tests), ending after they start', () => {
    expect(new Set(DEFAULT_HOME_WINDOWS.map((w) => w.day))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
    for (const w of DEFAULT_HOME_WINDOWS) {
      expect(w.end > w.start).toBe(true);
      expect(w.start >= '06:00' && w.end <= '11:00').toBe(true);
    }
  });
});
