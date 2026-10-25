import { Injectable } from '@nestjs/common';
import type { AuditEntry } from '@mc/contracts';
import { DomainError } from '@mc/nest-common';
import { RequestContext, TenantContext } from '@mc/tenancy';

type Entry = Pick<AuditEntry, 'actorId' | 'actorKind' | 'action' | 'resourceType' | 'purpose'> & Partial<Pick<AuditEntry, 'resourceId' | 'patientId' | 'actorName' | 'changes'>>;

/** Synchronous, fail-closed audit write (docs/LLD.md §15): no entry → no clinical data. */
@Injectable()
export class AuditClient {
  async record(...entries: Entry[]) {
    const body = { source: 'patient-service', entries: entries.map((e) => ({ resourceId: null, patientId: null, actorName: null, changes: null, ...e, requestId: RequestContext.current()?.requestId ?? null, ip: null })) };
    const res = await fetch(`${process.env.SVC_URL_AUDIT ?? 'http://localhost:4411'}/internal/tenants/${TenantContext.require().id}/audit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (!res?.ok) throw new DomainError(503, 'AUDIT_UNAVAILABLE', 'audit log unavailable, so clinical data is not shown');
  }
}
