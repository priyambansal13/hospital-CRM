import { describe, expect, it } from 'vitest';
import { allowedNumbers, unknownNumbers } from './numbers.js';

describe('number check', () => {
  const data = [{ label: 'No-show rate', from: '2026-10-01', to: '2026-10-31', rows: [{ label: 'Sat', value: 18.4 }, { label: 'Mon', value: 7.25 }], total: 1534.5 }];
  const ok = allowedNumbers(data);
  it('accepts figures from the data, rounded figures, dates and row counts', () => {
    expect(unknownNumbers('Saturday is worst at 18.4% (Monday 7.3%), from 2026-10-01 to 2026-10-31; 1,534.5 in total, 2 days compared.', ok)).toEqual([]);
    expect(unknownNumbers('Monday about 7%', ok)).toEqual([]);
  });
  it('flags invented or calculated figures', () => {
    expect(unknownNumbers('Saturday is 11.15 points higher, about 2.5 times Monday; 43 no-shows', ok)).toEqual(['11.15', '2.5', '43']);
  });
});
