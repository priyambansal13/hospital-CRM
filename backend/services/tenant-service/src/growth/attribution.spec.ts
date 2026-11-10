import { describe, expect, it } from 'vitest';
import { Attribution, channel, stored } from './attribution.js';

describe('attribution', () => {
  it('keeps ad click ids only with consent', () => {
    const raw = { source: 'Google', medium: 'cpc', campaign: 'clinic-software', gclid: 'Cj0KCQ-abc_1', fbclid: 'IwAR1', landing: '/for/clinics' };
    expect(stored(Attribution.parse({ ...raw, consent: false }))).toEqual({ attribution: { source: 'google', medium: 'cpc', campaign: 'clinic-software', landing: '/for/clinics' }, adsConsent: false });
    expect(stored(Attribution.parse({ ...raw, consent: true })).attribution).toMatchObject({ gclid: 'Cj0KCQ-abc_1', fbclid: 'IwAR1' });
  });
  it('drops markup and odd values instead of failing the signup', () => {
    expect(Attribution.parse({ campaign: '<script>', source: 'ok' })).toEqual({ source: 'ok', consent: false });
    expect(Attribution.parse({ landing: 'https://evil.example/' }).landing).toBeUndefined();
    expect(Attribution.parse(undefined)).toEqual({ consent: false });
    expect(Attribution.parse('garbage')).toEqual({ consent: false });
  });
  it('groups rows into channels', () => {
    expect(channel({})).toEqual({ source: 'direct', medium: '(none)', campaign: '(none)' });
    expect(channel({ gclid: 'x' })).toEqual({ source: 'google', medium: 'cpc', campaign: '(none)' });
    expect(channel({ source: 'linkedin', campaign: 'q1' })).toEqual({ source: 'linkedin', medium: '(none)', campaign: 'q1' });
  });
});
