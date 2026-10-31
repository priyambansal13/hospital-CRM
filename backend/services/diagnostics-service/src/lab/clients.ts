import { Injectable } from '@nestjs/common';
import type { AuditEntry } from '@mc/contracts';
import { DomainError, notFound } from '@mc/nest-common';
import { RequestContext, TenantContext } from '@mc/tenancy';

/** read at call time: the service's .env is loaded after modules are imported */
const internal = () => ({ 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' });
const svc = (name: string, port: number) => process.env[`SVC_URL_${name}`] ?? `http://localhost:${port}`;
const call = async (url: string, init: RequestInit = {}) => {
  const res = await fetch(url, { ...init, headers: { ...internal(), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return res;
};

export interface Patient { id: string; mrn: string; fullName: string; dob: string | null; gender: string | null; accountPersonId: string }

/** patient-service: "may this person act for this patient?" / any patient (staff paths, after their own checks). */
@Injectable()
export class PatientsClient {
  async access(patientId: string, personId: string): Promise<Patient> {
    const res = await call(`${svc('PATIENT', 4406)}/internal/tenants/${TenantContext.require().id}/patients/${patientId}/access/${personId}`);
    if (res?.status === 404) throw notFound('patient');
    if (!res?.ok) throw new DomainError(502, 'PATIENTS_UNAVAILABLE', 'patient-service unavailable');
    return (await res.json()) as Patient;
  }
  async get(patientId: string): Promise<Patient> {
    const res = await call(`${svc('PATIENT', 4406)}/internal/tenants/${TenantContext.require().id}/patients/${patientId}`);
    if (res?.status === 404) throw notFound('patient');
    if (!res?.ok) throw new DomainError(502, 'PATIENTS_UNAVAILABLE', 'patient-service unavailable');
    return (await res.json()) as Patient;
  }
}

/** records-service decides who is treating whom (one clinical access policy). */
@Injectable()
export class CareAccessClient {
  async check(userId: string, patientId: string): Promise<{ allowed: boolean; purpose: string; doctorName: string | null; doctorId: string | null }> {
    const res = await call(`${svc('RECORDS', 4410)}/internal/tenants/${TenantContext.require().id}/care-access?userId=${userId}&patientId=${patientId}&scope=DOCUMENTS`);
    if (!res?.ok) throw new DomainError(502, 'RECORDS_UNAVAILABLE', 'could not check access');
    return (await res.json()) as { allowed: boolean; purpose: string; doctorName: string | null; doctorId: string | null };
  }
}

type Entry = Pick<AuditEntry, 'actorId' | 'actorKind' | 'action' | 'resourceType' | 'purpose'> & Partial<Pick<AuditEntry, 'resourceId' | 'patientId' | 'actorName' | 'changes'>>;

/** Synchronous, fail-closed audit (docs/LLD.md §15). */
@Injectable()
export class AuditClient {
  async record(...entries: Entry[]) {
    const body = { source: 'diagnostics-service', entries: entries.map((e) => ({ resourceId: null, patientId: null, actorName: null, changes: null, ...e, requestId: RequestContext.current()?.requestId ?? null, ip: null })) };
    const res = await call(`${svc('AUDIT', 4411)}/internal/tenants/${TenantContext.require().id}/audit`, { method: 'POST', body: JSON.stringify(body) });
    if (!res?.ok) throw new DomainError(503, 'AUDIT_UNAVAILABLE', 'audit log unavailable, so patient data is not shown');
  }
}

export interface OnlineCheckout { invoiceId: string; invoiceNo: string; amount: number; currency: string; gateway: string; orderId: string; keyId: string }

/** billing-service: invoice + gateway order for an online lab booking. */
@Injectable()
export class BillingClient {
  async openOnline(body: Record<string, unknown>): Promise<OnlineCheckout> {
    const res = await call(`${svc('BILLING', 4409)}/internal/tenants/${TenantContext.require().id}/invoices/online`, { method: 'POST', body: JSON.stringify(body) });
    if (!res?.ok) throw new DomainError(502, 'PAYMENTS_UNAVAILABLE', `billing-service ${res?.status ?? 'unreachable'}`);
    return (await res.json()) as OnlineCheckout;
  }
}

export interface MemberBenefits { member: boolean; planName?: string; benefits?: { labDiscountPct: number; freeHomeCollection: boolean } }

/** billing-service: what an account's membership gives (Phase 26). Unreachable → no benefits (nobody gets one they did not buy). */
@Injectable()
export class MembershipClient {
  async benefits(personId: string): Promise<MemberBenefits> {
    const res = await call(`${svc('BILLING', 4409)}/internal/tenants/${TenantContext.require().id}/members/${personId}`);
    return res?.ok ? ((await res.json()) as MemberBenefits) : { member: false };
  }
}
