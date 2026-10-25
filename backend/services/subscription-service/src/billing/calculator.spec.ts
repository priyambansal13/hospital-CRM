import { describe, expect, it } from 'vitest';
import { calculate, monthlyTotal, remainingFraction, tierBreakdown } from './calculator.js';

const hospitalPro = { code: 'HOSPITAL_PRO', name: 'Hospital Professional', listPrice: 24999, components: [
  { model: 'PER_BRANCH' as const, unit: 'branch', amount: 2500, included: 2 },
  { model: 'TIERED' as const, unit: 'doctor', tiers: [{ upTo: 25, amount: 0 }, { upTo: 100, amount: 399 }, { upTo: null, amount: 299 }] },
] };

describe('invoice calculator', () => {
  it('flat plan, add-on and GST 18%', () => {
    const inv = calculate({ plan: { code: 'CLINIC_STARTER', name: 'Clinic Starter', listPrice: 4999, components: [] }, addons: [{ code: 'BRANCHES_5', name: '5 more branches', quantity: 1, listPrice: 2999 }], quantities: { doctor: 3, branch: 1 }, fraction: 1, periodLabel: 'Nov', gstPercent: 18 });
    expect(inv.subtotal).toBe(7998);
    expect(inv.gst).toBe(1439.64);
    expect(inv.total).toBe(9437.64);
  });

  it('per seat beyond the included ones', () => {
    const inv = calculate({ plan: { code: 'CLINIC_PRO', name: 'Clinic Professional', listPrice: 9999, components: [{ model: 'PER_SEAT', unit: 'doctor', amount: 499, included: 5 }] }, addons: [], quantities: { doctor: 8, branch: 1 }, fraction: 1, periodLabel: 'Nov', gstPercent: 0 });
    expect(inv.lines.find((l) => l.kind === 'SEATS')).toMatchObject({ quantity: 3, amount: 1497 });
    expect(inv.total).toBe(9999 + 1497);
  });

  it('tiers: each doctor at the rate of its tier; branches beyond 2', () => {
    expect(tierBreakdown(130, hospitalPro.components[1].tiers!)).toEqual([
      { from: 1, to: 25, quantity: 25, amount: 0 }, { from: 26, to: 100, quantity: 75, amount: 399 }, { from: 101, to: 130, quantity: 30, amount: 299 }]);
    expect(monthlyTotal({ plan: hospitalPro, addons: [], quantities: { doctor: 130, branch: 4 } })).toBe(24999 + 2 * 2500 + 75 * 399 + 30 * 299);
    expect(monthlyTotal({ plan: hospitalPro, addons: [], quantities: { doctor: 10, branch: 1 } })).toBe(24999);
  });

  it('proration: a part period charges its share; credits subtract', () => {
    const inv = calculate({ plan: hospitalPro, addons: [], quantities: { doctor: 10, branch: 1 }, fraction: 0.5, periodLabel: '16–30 Nov', credits: [{ description: 'Unused Clinic Starter', amount: 2499.5 }], gstPercent: 18 });
    expect(inv.lines[0]).toMatchObject({ description: 'Hospital Professional (16–30 Nov)', amount: 12499.5 });
    expect(inv.subtotal).toBe(10000);
    expect(inv.total).toBe(11800);
    expect(remainingFraction(new Date('2026-11-16'), new Date('2026-11-01'), new Date('2026-12-01'))).toBe(0.5);
  });

  it('usage beyond the allowance is billed only when the plan says ALLOW_BILL', () => {
    const base = { plan: { code: 'X', name: 'X', listPrice: 0, components: [] }, addons: [], quantities: { doctor: 0, branch: 0 }, fraction: 1, periodLabel: '', gstPercent: 0 };
    const sms = { key: 'core.sms', name: 'SMS messages', unit: 'SMS', used: 2203, limit: 2000, unitPrice: 0.2 };
    expect(calculate({ ...base, usage: [{ ...sms, overage: 'ALLOW_BILL' }] }).lines.find((l) => l.kind === 'USAGE')).toMatchObject({ quantity: 203, amount: 40.6 });
    expect(calculate({ ...base, usage: [{ ...sms, overage: 'SOFT_WARN' }] }).lines.some((l) => l.kind === 'USAGE')).toBe(false);
    expect(calculate({ ...base, usage: [{ ...sms, used: 1999, overage: 'ALLOW_BILL' }] }).lines.some((l) => l.kind === 'USAGE')).toBe(false);
  });

  it('coupons: percent of the subtotal, or a fixed amount capped at it; GST after the discount', () => {
    const base = { plan: { code: 'C', name: 'C', listPrice: 1000, components: [] }, addons: [], quantities: { doctor: 0, branch: 0 }, fraction: 1, periodLabel: '', gstPercent: 18 };
    expect(calculate({ ...base, coupon: { code: 'WELCOME20', percentOff: 20 } })).toMatchObject({ discount: 200, taxable: 800, gst: 144, total: 944 });
    expect(calculate({ ...base, coupon: { code: 'BIG', amountOff: 5000 } })).toMatchObject({ discount: 1000, total: 0 });
  });
});
