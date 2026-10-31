import { Injectable } from '@nestjs/common';
import { type EventEnvelope, LabOrderChanged } from '@mc/contracts';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { DomainError } from '@mc/nest-common';
import { type Queryable, TenantContext } from '@mc/tenancy';
import { WebhooksService } from '../hooks/webhooks.service.js';
import type { KeyPrincipal } from '../keys/api-keys.service.js';
import { IntegrationAudit } from './audit.js';
import { patient } from './mappers.js';

const svc = (name: string, port: number) => process.env[`SVC_URL_${name}`] ?? `http://localhost:${port}`;
const ns = (slug: string, kind: string) => `https://${slug}.medicare.app/fhir/${kind}`;

/** One result from the instruments: which order (its number), which test (our code), which parameter, the value. */
export interface LisResult { orderNo: string; testCode: string; parameter: string; value: string }

/**
 * LIS connector v1 (Phase 27). Out: when an order's samples reach the lab, a FHIR message Bundle (Patient +
 * one ServiceRequest per test, with the tube barcodes as Specimens) goes to the hospital's LIS endpoint, signed and
 * retried like a webhook. In: the LIS posts Observations back (API key with lis:write); they are entered as
 * "LIS: <key name>" and a pathologist verifies as usual.
 */
@Injectable()
export class LisService {
  constructor(private readonly hooks: WebhooksService, private readonly entitlements: EntitlementsClient, private readonly audit: IntegrationAudit) {}

  private async enabled(tenantId: string) {
    if ((await this.entitlements.moduleState(tenantId, 'integrations')) !== 'ACTIVE') return false;
    return (await this.entitlements.tenantFeatures(tenantId)).features['integrations.lis']?.enabled !== false;
  }

  async onInLab(c: Queryable, e: EventEnvelope) {
    const o0 = LabOrderChanged.parse(e.data);
    const { rows: [ep] } = await c.query(`SELECT 1 FROM endpoints WHERE kind = 'LIS' AND active`);
    const t = TenantContext.require();
    if (!ep || !(await this.enabled(t.id))) return;
    const res = await fetch(`${svc('DIAGNOSTICS', 4412)}/internal/tenants/${t.id}/lab-orders/${o0.orderId}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`diagnostics-service ${res.status}`); // retried with the event
    const o = (await res.json()) as any;
    await this.hooks.enqueueLis(c, e.id, 'lis.order', this.orderBundle(t.slug, e.id, o));
  }

  orderBundle(slug: string, messageId: string, o: any) {
    const specimens = (o.samples as any[]).filter((s) => s.status !== 'REJECTED').map((s, i) => ({
      resourceType: 'Specimen', id: `spec-${i + 1}`, identifier: [{ system: ns(slug, 'tube'), value: s.barcode }], type: { text: s.sampleType }, ...(s.collectedAt ? { collection: { collectedDateTime: new Date(s.collectedAt).toISOString() } } : {}),
    }));
    const requests = (o.tests as any[]).map((t, i) => ({
      resourceType: 'ServiceRequest', id: `req-${i + 1}`, status: 'active', intent: 'order',
      identifier: [{ system: ns(slug, 'lab-order'), value: o.orderNo }],
      code: { coding: [{ system: ns(slug, 'lab-test'), code: t.code, display: t.name }], text: t.name },
      subject: { reference: `Patient/${o.patient.id}` },
      specimen: specimens.filter((s) => s.type.text === t.sampleType).map((s) => ({ reference: `Specimen/${s.id}` })),
      ...(o.orderedBy ? { requester: { display: o.orderedBy.name } } : {}),
      ...(o.branch ? { locationReference: [{ reference: `Location/${o.branch.id}`, display: o.branch.name }] } : {}),
    }));
    const pt = patient(slug, { id: o.patient.id, mrn: o.patient.mrn, fullName: o.patient.name, dob: o.patient.dob, gender: o.patient.gender });
    return {
      resourceType: 'Bundle', id: messageId, type: 'message', timestamp: new Date().toISOString(),
      entry: [
        { resource: { resourceType: 'MessageHeader', id: 'header', eventCoding: { system: ns(slug, 'events'), code: 'lab-order' }, source: { name: 'MediCare', endpoint: `https://${slug}.medicare.app` }, focus: requests.map((r) => ({ reference: `ServiceRequest/${r.id}` })) } },
        { resource: pt }, ...requests.map((resource) => ({ resource })), ...specimens.map((resource) => ({ resource })),
      ],
    };
  }

  /** Observations → results per order. The order is the Observation's basedOn identifier (our order number). */
  parse(body: any): LisResult[] {
    if (body?.resourceType !== 'Bundle' || !Array.isArray(body.entry)) throw new DomainError(400, 'NOT_A_BUNDLE', 'send a FHIR Bundle of Observation resources');
    const out: LisResult[] = [];
    for (const [i, en] of (body.entry as any[]).entries()) {
      const r = en?.resource;
      if (r?.resourceType !== 'Observation') continue;
      const orderNo = r.basedOn?.[0]?.identifier?.value;
      const testCode = r.code?.coding?.[0]?.code;
      const parameter = r.code?.text ?? r.code?.coding?.[0]?.display;
      const value = r.valueQuantity?.value ?? r.valueString;
      if (!orderNo || !testCode || !parameter || value == null) throw new DomainError(400, 'INVALID_OBSERVATION', `entry ${i}: needs basedOn[0].identifier.value (order no.), code.coding[0].code (test code), code.text (parameter) and a value`);
      out.push({ orderNo: String(orderNo), testCode: String(testCode), parameter: String(parameter), value: String(value) });
    }
    if (!out.length) throw new DomainError(400, 'NO_OBSERVATIONS', 'the Bundle has no Observation resources');
    if (out.length > 500) throw new DomainError(400, 'TOO_MANY', 'send at most 500 results at a time');
    return out;
  }

  async receive(k: KeyPrincipal, results: LisResult[]) {
    const t = TenantContext.require();
    if (!(await this.enabled(t.id))) throw new DomainError(403, 'FEATURE_DISABLED', 'the LIS connector is not part of this hospital\'s plan');
    const byOrder = new Map<string, LisResult[]>();
    for (const r of results) byOrder.set(r.orderNo, [...(byOrder.get(r.orderNo) ?? []), r]);
    const outcomes: { orderNo: string; status: number; entered?: number; allResulted?: boolean; error?: string }[] = [];
    for (const [orderNo, rs] of byOrder) {
      const res = await fetch(`${svc('DIAGNOSTICS', 4412)}/internal/tenants/${t.id}/lis/results`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ orderNo, source: k.name, results: rs.map(({ testCode, parameter, value }) => ({ testCode, parameter, value })) }),
      }).catch(() => null);
      const j = res ? ((await res.json().catch(() => ({}))) as any) : {};
      outcomes.push(res?.ok ? { orderNo, status: 200, entered: j.entered, allResulted: j.allResulted } : { orderNo, status: res?.status ?? 502, error: j.detail ?? j.message ?? 'diagnostics unavailable' });
    }
    await this.audit.record(k, { action: 'UPDATE', resourceType: 'LIS_RESULTS', changes: outcomes.map((o) => `${o.orderNo}:${o.status}`) });
    return outcomes;
  }
}
