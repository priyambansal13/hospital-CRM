import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { checkUrl, sign } from '../hooks/outbound.js';
import { LisService } from './lis.js';
import { appointment, diagnosticReport, patient } from './mappers.js';

describe('outbound calls', () => {
  afterEach(() => { delete process.env.WEBHOOK_ALLOW_PRIVATE; });
  it('signs "t.body" with the secret', () => {
    const s = sign('whsec_x', '{"a":1}', 1700000000);
    expect(s).toBe(`t=1700000000,v1=${createHmac('sha256', 'whsec_x').update('1700000000.{"a":1}').digest('hex')}`);
  });
  it('refuses private addresses and plain http in production', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = 'false';
    expect(await checkUrl('http://example.com/x')).toMatch(/https/);
    expect(await checkUrl('https://127.0.0.1/x')).toMatch(/private/);
    expect(await checkUrl('https://10.1.2.3/x')).toMatch(/private/);
    expect(await checkUrl('https://192.168.0.5/x')).toMatch(/private/);
    expect(await checkUrl('https://[::1]/x')).toMatch(/private/);
    expect(await checkUrl('https://user:pw@example.com/x')).toMatch(/credentials/);
    expect(await checkUrl('ftp://example.com/x')).toMatch(/https/);
    expect(await checkUrl('https://93.184.216.34/hook')).toBeNull();
  });
});

describe('FHIR mapping', () => {
  it('Patient and Appointment', () => {
    const p = patient('citycare', { id: 'p1', mrn: 'MRN1', fullName: 'Asha Verma', gender: 'FEMALE', dob: '1980-03-03', phone: '+919800000000', email: null });
    expect(p).toMatchObject({ resourceType: 'Patient', gender: 'female', birthDate: '1980-03-03', identifier: [{ value: 'MRN1', system: 'https://citycare.medicare.app/fhir/mrn' }] });
    expect(p.telecom).toEqual([{ system: 'phone', value: '+919800000000', use: 'mobile' }]);
    const a = appointment('citycare', { id: 'a1', appointmentNo: 'APT-1', status: 'NO_SHOW', mode: 'IN_PERSON', source: 'ONLINE', startsAt: '2026-10-31T04:00:00Z', endsAt: '2026-10-31T04:15:00Z', createdAt: '2026-10-30T00:00:00Z', patient: { id: 'p1', name: 'A' }, doctor: { id: 'd1', name: 'Dr' }, branch: { id: 'b1', name: 'S44' } });
    expect(a.status).toBe('noshow');
    expect(a.participant.map((x) => x.actor.reference)).toEqual(['Patient/p1', 'Practitioner/d1', 'Location/b1']);
  });
  it('DiagnosticReport with values, units, ranges and flags', () => {
    const r = diagnosticReport('citycare', {
      order: { id: 'o1', orderNo: 'LAB-1', patient: { id: 'p1', name: 'A' } }, collectedAt: '2026-10-31T03:00:00Z',
      reports: [{ id: 'r1', version: 1, superseded: true }, { id: 'r2', version: 2, superseded: false, verifiedAt: '2026-10-31T06:00:00Z', verifiedBy: 'Dr. Path' }],
      tests: [{ code: 'FBS', name: 'Fasting Blood Sugar', parameters: [{ parameter: 'Glucose', value: '452', unit: 'mg/dL', refLow: 70, refHigh: 100, flag: 'CRITICAL_HIGH' }] },
        { code: 'DENGUE', name: 'Dengue NS1', parameters: [{ parameter: 'NS1', value: 'Negative', unit: null, refLow: null, refHigh: null, flag: 'NORMAL' }, { parameter: 'X', value: null }] }],
    });
    expect(r).toMatchObject({ id: 'r2', status: 'amended', issued: '2026-10-31T06:00:00.000Z' });
    expect(r.contained).toHaveLength(2);
    expect(r.contained[0]).toMatchObject({ valueQuantity: { value: 452, unit: 'mg/dL' }, interpretation: [{ coding: [{ code: 'HH' }] }], referenceRange: [{ low: { value: 70 }, high: { value: 100 } }] });
    expect(r.contained[1]).toMatchObject({ valueString: 'Negative' });
    expect(r.result).toEqual([{ reference: '#obs-1' }, { reference: '#obs-2' }]);
  });
});

describe('LIS results', () => {
  const lis = new LisService(null as any, null as any, null as any);
  const obs = (o: Record<string, unknown>) => ({ resource: { resourceType: 'Observation', basedOn: [{ identifier: { value: 'LAB-1' } }], code: { coding: [{ code: 'FBS' }], text: 'Glucose' }, valueQuantity: { value: 96 }, ...o } });
  it('reads order, test, parameter and value', () => {
    expect(lis.parse({ resourceType: 'Bundle', entry: [obs({}), obs({ valueQuantity: undefined, valueString: 'Positive' }), { resource: { resourceType: 'Patient' } }] }))
      .toEqual([{ orderNo: 'LAB-1', testCode: 'FBS', parameter: 'Glucose', value: '96' }, { orderNo: 'LAB-1', testCode: 'FBS', parameter: 'Glucose', value: 'Positive' }]);
  });
  it('refuses what it cannot file', () => {
    expect(() => lis.parse({ resourceType: 'Observation' })).toThrow(/Bundle/);
    expect(() => lis.parse({ resourceType: 'Bundle', entry: [obs({ basedOn: undefined })] })).toThrow(/order no/);
    expect(() => lis.parse({ resourceType: 'Bundle', entry: [] })).toThrow(/no Observation/);
  });
});
