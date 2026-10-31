import { Injectable } from '@nestjs/common';
import { DomainError } from '@mc/nest-common';
import { RequestContext, TenantContext } from '@mc/tenancy';
import type { KeyPrincipal } from '../keys/api-keys.service.js';

/** Every FHIR read and LIS write is in the hospital's audit log, as the API key that made it (fail closed). */
@Injectable()
export class IntegrationAudit {
  async record(k: KeyPrincipal, e: { action: 'READ' | 'UPDATE'; resourceType: string; resourceId?: string | null; patientId?: string | null; changes?: string[] | null }) {
    const body = { source: 'integration-service', entries: [{ actorId: k.keyId, actorKind: 'system', actorName: `API key: ${k.name}`.slice(0, 120), purpose: 'ADMIN', resourceId: null, patientId: null, changes: null, ...e, requestId: RequestContext.current()?.requestId ?? null, ip: null }] };
    const res = await fetch(`${process.env.SVC_URL_AUDIT ?? 'http://localhost:4411'}/internal/tenants/${TenantContext.require().id}/audit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res?.ok) throw new DomainError(503, 'AUDIT_UNAVAILABLE', 'the audit log is unavailable, so no patient data is returned');
  }
}
