import { describe, expect, it } from 'vitest';
import { devOpsStep, periodFrom } from '../llm/dev-ops.js';
import { plainAnswer } from './agent.js';
import { checkWording, render } from './care-gaps.js';

describe('care-gap wording', () => {
  it('accepts placeholders and the booking link, refuses the rest', () => {
    expect(checkWording('A reminder from {{hospital}}', 'Hello {{patientName}}, your {{testName}} is due. Book here: {{link}}')).toBeNull();
    expect(checkWording('Reminder', 'Hello {{patientName}}, your test is due at {{hospital}} soon.')).toMatch(/link/);
    expect(checkWording('Reminder', 'Hello {{name}}, book your test: {{link}} today')).toMatch(/placeholder/);
    expect(checkWording('Reminder', 'As you have diabetes, book your {{testName}}: {{link}}')).toMatch(/condition/);
    expect(checkWording('Reminder', 'Your blood pressure needs a {{testName}}: {{link}} today')).toMatch(/condition/);
  });
  it('fills placeholders and leaves the link for the notifier', () => {
    expect(render('Hi {{patientName}}, {{testName}}: {{link}}', { patientName: 'Leela', testName: 'HbA1c', link: '{{link}}' })).toBe('Hi Leela, HbA1c: {{link}}');
  });
});

describe('Ops agent (dev model and fallback wording)', () => {
  it('reads periods in India dates', () => {
    expect(periodFrom('no-shows last month', '2026-11-01')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodFrom('last 7 days', '2026-11-01')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(periodFrom('anything', '2026-11-01')).toEqual({ from: '2026-10-03', to: '2026-11-01' });
  });
  it('turns a question into metric calls, one per split', () => {
    const step = devOpsStep('<today>2026-11-01</today>', [{ role: 'user', text: 'Which department had the worst no-show rate last month, by weekday?' }]);
    expect('calls' in step && step.calls.map((c) => c.args)).toEqual([
      { metric: 'no_show_rate', from: '2026-10-01', to: '2026-10-31', group_by: 'specialty' },
      { metric: 'no_show_rate', from: '2026-10-01', to: '2026-10-31', group_by: 'weekday' },
    ]);
    const one = devOpsStep('', [{ role: 'user', text: 'by day of the week, no-show rate' }]);
    expect('calls' in one && one.calls.map((c) => c.args.group_by)).toEqual(['weekday']);
  });
  it('the fallback wording quotes the tables only', () => {
    const text = plainAnswer([{ title: 'No-show rate by weekday', metric: 'no_show_rate', unit: 'percent', from: '2026-10-01', to: '2026-10-31', groupLabel: 'Day of the week', value: null, rows: [{ label: 'Mon', value: 7.5 }, { label: 'Sat', value: 18.4 }, { label: 'Sun', value: null }] }]);
    expect(text).toBe('No-show rate by weekday, 2026-10-01 to 2026-10-31: highest Sat (18.4%), lowest Mon (7.5%).');
  });
});
