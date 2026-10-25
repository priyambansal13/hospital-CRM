import { describe, expect, it } from 'vitest';
import { TimeBasedRefundPolicy } from './refund-policy.js';

const p = TimeBasedRefundPolicy({ fullRefundHours: 24, partialRefundHours: 2, partialPercent: 50 });
const now = new Date('2026-11-02T04:30:00Z');
const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000);

describe('time-based refund policy', () => {
  it('nothing to refund when nothing was paid', () => {
    expect(p.percent({ paid: false, cancelledBy: 'patient', startsAt: inHours(48), now })).toBeNull();
  });
  it('patient: full ≥ 24 h, half between 2 and 24 h, none under 2 h', () => {
    expect(p.percent({ paid: true, cancelledBy: 'patient', startsAt: inHours(24), now })).toBe(100);
    expect(p.percent({ paid: true, cancelledBy: 'patient', startsAt: inHours(23.9), now })).toBe(50);
    expect(p.percent({ paid: true, cancelledBy: 'patient', startsAt: inHours(2), now })).toBe(50);
    expect(p.percent({ paid: true, cancelledBy: 'patient', startsAt: inHours(1.5), now })).toBe(0);
  });
  it('the hospital cancelling always refunds in full', () => {
    expect(p.percent({ paid: true, cancelledBy: 'hospital', startsAt: inHours(0.5), now })).toBe(100);
  });
});
