import { describe, expect, it } from 'vitest';
import { noShowRisk } from './outreach.job.js';

describe('no-show risk', () => {
  it('weighs earlier no-shows most and explains itself', () => {
    expect(noShowRisk({ priorNoShows: 2, priorVisits: 3, leadDays: 2, paid: false, source: 'ONLINE' })).toEqual({ score: 4, reasons: ['2 earlier no-shows', 'not paid ahead'] });
    expect(noShowRisk({ priorNoShows: 0, priorVisits: 0, leadDays: 20, paid: false, source: 'ONLINE' }).score).toBe(3);
  });
  it('a regular who paid ahead is low risk', () => {
    expect(noShowRisk({ priorNoShows: 0, priorVisits: 5, leadDays: 3, paid: true, source: 'ONLINE' }).score).toBe(0);
    expect(noShowRisk({ priorNoShows: 1, priorVisits: 4, leadDays: 3, paid: true, source: 'DESK' }).score).toBe(1);
  });
});
