import { describe, expect, it } from 'vitest';
import { mask } from './notifications.controller.js';
import { DEFAULT_TEMPLATES, render, STAFF_ONLY_KEYS } from './templates.js';

describe('templates', () => {
  it('render replaces placeholders and blanks unknown ones', () => {
    expect(render('Hi {{ name }}, see {{doctor}} at {{missing}}.', { name: 'Ravi', doctor: 'Dr. Rao' })).toBe('Hi Ravi, see Dr. Rao at .');
  });

  it('every key has an English SMS, every EMAIL has a subject, SMS stay short and carry no clinical words', () => {
    const keys = new Set(DEFAULT_TEMPLATES.map((t) => t.key));
    for (const k of keys) {
      if (STAFF_ONLY_KEYS.has(k)) expect(DEFAULT_TEMPLATES.filter((t) => t.key === k).every((t) => t.channel === 'EMAIL'), k).toBe(true);
      else expect(DEFAULT_TEMPLATES.some((t) => t.key === k && t.channel === 'SMS' && t.language === 'en'), k).toBe(true);
    }
    for (const t of DEFAULT_TEMPLATES.filter((x) => x.channel === 'EMAIL')) expect(t.subject).toBeTruthy();
    const sample = { hospital: 'CityCare Clinic', appointmentNo: 'APT-2026-000123', patientName: 'Kavya Menon', doctorName: 'Dr. Asha Rao', when: 'Sat, 24 Oct, 4:00 PM', date: 'Sat, 24 Oct', time: '4:00 PM', where: 'Sector 44', link: 'https://citycare.medicare.app/care/appointments' };
    for (const t of DEFAULT_TEMPLATES.filter((x) => x.channel === 'SMS')) {
      expect(render(t.body, sample).length).toBeLessThanOrEqual(t.language === 'en' ? 200 : 260);
      expect(t.body).not.toMatch(/diagnos|reason|test result|report/i);
    }
  });
});

describe('mask', () => {
  it('hides most of a phone number or email', () => {
    expect(mask('+919876543210')).toBe('+91******3210');
    expect(mask('kavya@example.com')).toBe('k***@example.com');
    expect(mask(null)).toBeNull();
  });
});
