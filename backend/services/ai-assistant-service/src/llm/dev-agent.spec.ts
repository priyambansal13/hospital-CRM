import { describe, expect, it } from 'vitest';
import { userTurn } from '../chat/prompts.js';
import { dateFrom, devAgentStep, optionsFrom, partFrom, topic } from './dev-agent.js';
import type { ToolDecl, Turn } from './llm.js';

const TOOLS: ToolDecl[] = ['list_my_reports', 'explain_report', 'search_doctors', 'propose_booking', 'list_my_appointments', 'propose_cancel', 'search_lab_tests', 'get_available_slots', 'propose_reschedule']
  .map((name) => ({ name, description: '', parameters: {} }));
const ask = (q: string): Turn => ({ role: 'user', text: userTurn([], q, { today: '2026-10-31', weekday: 'Saturday', family: [] }) });
const search = { date: '2026-11-07', partOfDay: 'MORNING', doctors: [
  { doctorId: 'd1', name: 'Dr. A', specialty: 'Dermatology', slots: [{ slotId: 's1', date: '2026-11-07', time: '09:00', branch: 'Sector 44', fee: 500 }, { slotId: 's2', date: '2026-11-07', time: '09:30', branch: 'Sector 44', fee: 500 }] },
  { doctorId: 'd2', name: 'Dr. B', specialty: 'Dermatology', slots: [{ slotId: 's3', date: '2026-11-07', time: '10:00', branch: 'Sector 44', fee: 600 }] },
] };

describe('dev agent: reading the request', () => {
  it('dates from words, counted from today in India (2026-10-31 is a Saturday)', () => {
    expect(dateFrom('saturday morning', '2026-10-31')).toBe('2026-10-31');
    expect(dateFrom('next monday', '2026-10-31')).toBe('2026-11-02');
    expect(dateFrom('tomorrow', '2026-10-31')).toBe('2026-11-01');
    expect(dateFrom('on 2026-11-05', '2026-10-31')).toBe('2026-11-05');
    expect(dateFrom('any day', '2026-10-31')).toBeUndefined();
  });
  it('part of the day and the topic words', () => {
    expect(partFrom('saturday morning')).toBe('MORNING');
    expect(partFrom('in the evening')).toBe('EVENING');
    expect(topic('i need a skin doctor on saturday morning')).toBe('skin doctor');
    expect(topic('book an appointment with dr kalpana rao tomorrow')).toBe('kalpana rao');
  });
  it('offers one time per doctor first, at most three', () => {
    expect(optionsFrom(search).map((o) => o.slotId)).toEqual(['s1', 's3', 's2']);
  });
});

describe('dev agent: the tool loop', () => {
  it('a booking request searches doctors with the date and part of day', () => {
    const step = devAgentStep([ask('Need a skin doctor next Saturday morning')], TOOLS);
    expect(step).toEqual({ calls: [expect.objectContaining({ name: 'search_doctors', args: { query: 'skin doctor', date: '2026-10-31', partOfDay: 'MORNING' } })] });
  });
  it('after the search it proposes the first time, then answers with the options', () => {
    const turns: Turn[] = [ask('skin doctor saturday'), { role: 'model', calls: [{ name: 'search_doctors', args: {} }] }, { role: 'user', results: [{ name: 'search_doctors', response: search }] }];
    expect(devAgentStep(turns, TOOLS)).toEqual({ calls: [expect.objectContaining({ name: 'propose_booking', args: { slotId: 's1' } })] });
    turns.push({ role: 'model', calls: [{ name: 'propose_booking', args: { slotId: 's1' } }] }, { role: 'user', results: [{ name: 'propose_booking', response: { pendingActionId: 'x', doctor: 'Dr. A', date: '2026-11-07', time: '09:00', patient: 'Asha' } }] });
    const end = devAgentStep(turns, TOOLS) as { text: string };
    expect(end.text).toMatch(/1\. Dr\. A/);
    expect(end.text).toMatch(/Tap Confirm/);
  });
  it('"the second one" on the next message picks the second time offered (not the first)', () => {
    const turns: Turn[] = [ask('skin doctor saturday'), { role: 'model', calls: [{ name: 'search_doctors', args: {} }] }, { role: 'user', results: [{ name: 'search_doctors', response: search }] }, { role: 'model', text: 'options…' }, ask('the second one please')];
    expect(devAgentStep(turns, TOOLS)).toEqual({ calls: [expect.objectContaining({ name: 'propose_booking', args: { slotId: 's3' } })] });
  });
  it('without the booking tools (plan or role) it only lists times and never proposes', () => {
    const noBooking = TOOLS.filter((t) => !t.name.startsWith('propose_'));
    const turns: Turn[] = [ask('skin doctor saturday'), { role: 'model', calls: [{ name: 'search_doctors', args: {} }] }, { role: 'user', results: [{ name: 'search_doctors', response: search }] }];
    const end = devAgentStep(turns, noBooking) as { text: string };
    expect(end.text).toMatch(/Find a doctor/);
  });
  it('cancel with one upcoming appointment proposes cancelling it', () => {
    const turns: Turn[] = [ask('please cancel my appointment'), { role: 'model', calls: [{ name: 'list_my_appointments', args: {} }] },
      { role: 'user', results: [{ name: 'list_my_appointments', response: { appointments: [{ appointmentId: 'a1', appointmentNo: 'APT-1', doctor: 'Dr. A', doctorId: 'd1', date: '2026-11-07', time: '09:00', patient: 'Asha' }] } }] }];
    expect(devAgentStep([turns[0]], TOOLS)).toEqual({ calls: [expect.objectContaining({ name: 'list_my_appointments' })] });
    expect(devAgentStep(turns, TOOLS)).toEqual({ calls: [expect.objectContaining({ name: 'propose_cancel', args: { appointmentId: 'a1' } })] });
  });
  it('lab questions search tests; hospital questions use no tool', () => {
    expect(devAgentStep([ask('How much is the thyroid test?')], TOOLS)).toEqual({ calls: [expect.objectContaining({ name: 'search_lab_tests', args: { query: 'thyroid' } })] });
    expect(devAgentStep([ask('What are the visiting hours?')], TOOLS)).toBeNull();
    expect(devAgentStep([ask('Do I need to fast before a blood test?')], TOOLS)).toBeNull();
  });
  it('a report question lists reports, explains the newest from its values, and sends the patient to their doctor', () => {
    const turns: Turn[] = [ask('What does my blood test report mean?')];
    expect(devAgentStep(turns, TOOLS)).toEqual({ calls: [expect.objectContaining({ name: 'list_my_reports' })] });
    turns.push({ role: 'model', calls: [{ name: 'list_my_reports', args: {} }] }, { role: 'user', results: [{ name: 'list_my_reports', response: { reports: [{ orderId: 'o2', orderNo: 'LAB-2', tests: ['HbA1c'], date: '2026-10-30' }, { orderId: 'o1', orderNo: 'LAB-1', tests: ['CBC'], date: '2026-10-01' }] } }] });
    expect(devAgentStep(turns, TOOLS)).toEqual({ calls: [expect.objectContaining({ name: 'explain_report', args: { orderId: 'o2' } })] });
    turns.push({ role: 'model', calls: [{ name: 'explain_report', args: { orderId: 'o2' } }] }, { role: 'user', results: [{ name: 'explain_report', response: { criticalHeld: false, orderNo: 'LAB-2', date: '2026-10-30', orderedBy: 'Dr. Rao', tests: [{ test: 'HbA1c', values: [{ name: 'HbA1c', value: '7.2', unit: '%', normalRange: '4–5.6', flag: 'HIGH' }] }] } }] });
    const end = devAgentStep(turns, TOOLS) as { text: string };
    expect(end.text).toMatch(/HbA1c is 7\.2 %, above the normal range \(4–5\.6\)/);
    expect(end.text).toMatch(/discuss these results with your doctor/);
    expect(end.text).toMatch(/follow-up with Dr\. Rao/);
  });
});
