import { describe, expect, it } from 'vitest';
import { QueueHub } from './hub.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const BR = '44444444-4444-4444-8444-444444444444';
const evt = (tenantId: string, type = 'scheduling.appointment_checked_in', data: Record<string, unknown> = {}) => JSON.stringify({
  specversion: '1.0', id: crypto.randomUUID(), type, source: 'scheduling-service', time: new Date().toISOString(), tenantId,
  data: { appointmentId: crypto.randomUUID(), appointmentNo: 'APT-2026-000001', patientId: crypto.randomUUID(), accountPersonId: crypto.randomUUID(), doctorId: DOC, branchId: BR, startsAt: new Date().toISOString(), status: 'CHECKED_IN', tokenNo: 4, patientName: 'Secret Name', ...data },
});

describe('QueueHub', () => {
  it('delivers to the matching doctor or branch of the same hospital only, without patient details', () => {
    const hub = new QueueHub();
    const got: Record<string, unknown[]> = { doc: [], branch: [], other: [], otherTenant: [] };
    hub.subscribe({ tenantId: T1, doctorId: DOC, send: (s) => got.doc.push(s) });
    hub.subscribe({ tenantId: T1, branchId: BR, send: (s) => got.branch.push(s) });
    hub.subscribe({ tenantId: T1, doctorId: crypto.randomUUID(), send: (s) => got.other.push(s) });
    hub.subscribe({ tenantId: T2, doctorId: DOC, send: (s) => got.otherTenant.push(s) });
    hub.onMessage(evt(T1));
    expect(got.doc).toHaveLength(1);
    expect(got.branch).toHaveLength(1);
    expect(got.other).toHaveLength(0);
    expect(got.otherTenant).toHaveLength(0);
    expect(JSON.stringify(got.doc[0])).not.toContain('Secret Name');
    expect(got.doc[0]).toMatchObject({ doctorId: DOC, status: 'CHECKED_IN', tokenNo: 4 });
  });

  it('ignores unrelated events, events without a tenant and junk', () => {
    const hub = new QueueHub();
    const got: unknown[] = [];
    hub.subscribe({ tenantId: T1, doctorId: DOC, send: (s) => got.push(s) });
    hub.onMessage(evt(T1, 'scheduling.availability_changed'));
    hub.onMessage('not json');
    hub.onMessage(null);
    expect(got).toHaveLength(0);
  });

  it('stops delivering after unsubscribe', () => {
    const hub = new QueueHub();
    const got: unknown[] = [];
    const off = hub.subscribe({ tenantId: T1, doctorId: DOC, send: (s) => got.push(s) });
    off();
    hub.onMessage(evt(T1));
    expect(got).toHaveLength(0);
    expect(hub.size).toBe(0);
  });
});
