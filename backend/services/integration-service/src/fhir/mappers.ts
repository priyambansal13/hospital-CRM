/**
 * Our records as HL7 FHIR R4 resources (docs/HLD.md "FHIR alignment"). Read-only, JSON. Identifiers use the
 * hospital's own namespace: https://<slug>.medicare.app/fhir/<kind>.
 */
type Any = Record<string, any>;
const ns = (slug: string, kind: string) => `https://${slug}.medicare.app/fhir/${kind}`;
const GENDER: Record<string, string> = { FEMALE: 'female', MALE: 'male', OTHER: 'other' };
const APPT_STATUS: Record<string, string> = {
  PENDING_PAYMENT: 'pending', CONFIRMED: 'booked', CHECKED_IN: 'arrived', IN_PROGRESS: 'checked-in', COMPLETED: 'fulfilled',
  CANCELLED: 'cancelled', EXPIRED: 'cancelled', RESCHEDULED: 'cancelled', NO_SHOW: 'noshow',
};
const INTERP: Record<string, [string, string]> = { NORMAL: ['N', 'Normal'], LOW: ['L', 'Low'], HIGH: ['H', 'High'], CRITICAL_LOW: ['LL', 'Critical low'], CRITICAL_HIGH: ['HH', 'Critical high'], ABNORMAL: ['A', 'Abnormal'] };

export function patient(slug: string, p: Any) {
  return {
    resourceType: 'Patient', id: p.id,
    identifier: [{ use: 'usual', type: { text: 'Medical record number' }, system: ns(slug, 'mrn'), value: p.mrn }],
    active: true, name: [{ use: 'official', text: p.fullName }],
    telecom: [...(p.phone ? [{ system: 'phone', value: p.phone, use: 'mobile' }] : []), ...(p.email ? [{ system: 'email', value: p.email }] : [])],
    gender: GENDER[p.gender ?? ''] ?? 'unknown', ...(p.dob ? { birthDate: String(p.dob).slice(0, 10) } : {}),
  };
}

export function appointment(slug: string, a: Any) {
  return {
    resourceType: 'Appointment', id: a.id,
    identifier: [{ system: ns(slug, 'appointment'), value: a.appointmentNo }],
    status: APPT_STATUS[a.status] ?? 'entered-in-error',
    ...(a.status === 'CANCELLED' && a.cancelReason ? { cancellationReason: { text: a.cancelReason } } : {}),
    appointmentType: { text: a.mode === 'VIDEO' ? 'Video consultation' : a.source === 'WALK_IN' ? 'Walk-in' : 'Consultation' },
    ...(a.reason ? { description: a.reason } : {}),
    start: new Date(a.startsAt).toISOString(), end: new Date(a.endsAt).toISOString(), created: new Date(a.createdAt).toISOString(),
    participant: [
      { actor: { reference: `Patient/${a.patient.id}`, display: a.patient.name }, status: 'accepted' },
      { actor: { reference: `Practitioner/${a.doctor.id}`, display: a.doctor.name }, status: 'accepted' },
      { actor: { reference: `Location/${a.branch.id}`, display: a.branch.name }, status: 'accepted' },
    ],
  };
}

/** A published lab order → DiagnosticReport with its values as contained Observations. */
export function diagnosticReport(slug: string, s: Any) {
  const o = s.order;
  const latest = [...s.reports].reverse().find((r: Any) => !r.superseded) ?? s.reports.at(-1);
  const obs: Any[] = [];
  for (const t of s.tests) {
    for (const p of t.parameters) {
      if (p.value == null) continue;
      const n = Number(p.value);
      const i = INTERP[p.flag ?? ''];
      obs.push({
        resourceType: 'Observation', id: `obs-${obs.length + 1}`, status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
        code: { coding: [{ system: ns(slug, 'lab-test'), code: t.code, display: t.name }], text: t.parameters.length > 1 ? `${t.name}: ${p.parameter}` : t.name },
        subject: { reference: `Patient/${o.patient.id}` },
        ...(Number.isFinite(n) && String(p.value).trim() !== '' ? { valueQuantity: { value: n, ...(p.unit ? { unit: p.unit } : {}) } } : { valueString: String(p.value) }),
        ...(i ? { interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: i[0], display: i[1] }] }] } : {}),
        ...(p.refLow != null || p.refHigh != null ? { referenceRange: [{ ...(p.refLow != null ? { low: { value: Number(p.refLow), ...(p.unit ? { unit: p.unit } : {}) } } : {}), ...(p.refHigh != null ? { high: { value: Number(p.refHigh), ...(p.unit ? { unit: p.unit } : {}) } } : {}) }] } : {}),
      });
    }
  }
  return {
    resourceType: 'DiagnosticReport', id: latest?.id ?? o.id,
    identifier: [{ system: ns(slug, 'lab-order'), value: o.orderNo }],
    status: (latest?.version ?? 1) > 1 ? 'amended' : 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB', display: 'Laboratory' }] }],
    code: { text: s.tests.map((t: Any) => t.name).join(', ') },
    subject: { reference: `Patient/${o.patient.id}`, display: o.patient.name },
    ...(s.collectedAt ? { effectiveDateTime: new Date(s.collectedAt).toISOString() } : {}),
    ...(latest?.verifiedAt ? { issued: new Date(latest.verifiedAt).toISOString() } : {}),
    ...(latest?.verifiedBy ? { resultsInterpreter: [{ display: latest.verifiedBy }] } : {}),
    contained: obs, result: obs.map((x) => ({ reference: `#${x.id}` })),
  };
}

export const bundle = (base: string, resources: Any[]) => ({
  resourceType: 'Bundle', type: 'searchset', total: resources.length,
  entry: resources.map((r) => ({ fullUrl: `${base}/${r.resourceType}/${r.id}`, resource: r, search: { mode: 'match' } })),
});

export const outcome = (status: number, code: string, text: string) => ({
  resourceType: 'OperationOutcome',
  issue: [{ severity: 'error', code: status === 401 ? 'login' : status === 403 ? 'forbidden' : status === 404 ? 'not-found' : status === 400 || status === 422 ? 'invalid' : 'exception', details: { text }, diagnostics: code }],
});

export const capabilityStatement = (base: string) => ({
  resourceType: 'CapabilityStatement', status: 'active', date: '2026-10-31', kind: 'instance', fhirVersion: '4.0.1', format: ['application/fhir+json'],
  software: { name: 'MediCare', version: '1' }, implementation: { description: 'MediCare read API (one hospital per address)', url: base },
  rest: [{
    mode: 'server',
    security: { description: 'Authorization: Bearer <API key with the fhir:read scope>, created by the hospital admin (Integrations).' },
    resource: [
      { type: 'Patient', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'identifier', type: 'token', documentation: 'the MRN' }] },
      { type: 'Appointment', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }] },
      { type: 'DiagnosticReport', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }] },
    ],
  }],
});
