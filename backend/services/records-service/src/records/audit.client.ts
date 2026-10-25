import { Injectable } from '@nestjs/common';
import type { AuditEntry } from '@mc/contracts';
import { DomainError } from '@mc/nest-common';
import { RequestContext, TenantContext } from '@mc/tenancy';

type Entry = Omit<AuditEntry, 'requestId' | 'ip' | 'changes' | 'resourceId' | 'patientId' | 'actorName'> & Partial<Pick<AuditEntry, 'resourceId' | 'patientId' | 'actorName' | 'changes'>>;

/**
 * Writes to audit-service synchronously. Fail closed (docs/LLD.md §15): if the audit write fails, the read or write
 * of patient data fails too — never patient data without its audit entry.
 */
@Injectable()
export class AuditClient {
  private readonly base = process.env.SVC_URL_AUDIT ?? 'http://localhost:4411';

  async record(...entries: Entry[]) {
    const requestId = RequestContext.current()?.requestId ?? null;
    const body = {
      source: 'records-service',
      entries: entries.map((e) => ({ resourceId: null, patientId: null, actorName: null, changes: null, ...e, requestId, ip: null })),
    };
    let res: Response;
    try {
      res = await fetch(`${this.base}/internal/tenants/${TenantContext.require().id}/audit`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
      });
    } catch (e) {
      throw new DomainError(503, 'AUDIT_UNAVAILABLE', `audit log unavailable, so patient data is not shown: ${(e as Error).message}`);
    }
    if (!res.ok) throw new DomainError(503, 'AUDIT_UNAVAILABLE', `audit log refused the entry (${res.status}), so patient data is not shown`);
  }
}
