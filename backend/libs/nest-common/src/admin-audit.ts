import { applyDecorators, type CallHandler, type ExecutionContext, Injectable, Logger, type NestInterceptor, SetMetadata, UseInterceptors } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Actor, RequestContext, TenantContext } from '@mc/tenancy';
import { from, mergeMap, type Observable } from 'rxjs';
import { DomainError } from './errors.js';

export interface AdminAction {
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  /** what was changed: STAFF, ROLE_GRANT, ROLE, SETTING, TEMPLATE, LAB_PRICE, DOCTOR_FEE, REFUND, PAYOUT_ACCOUNT… */
  resourceType: string;
  resourceId?: string | null;
  /** field names / keys that changed (never values that could be personal or clinical) */
  changes?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Configuration changes and other admin actions go into the hospital's audit log with purpose ADMIN, shown under
 * "Configuration" in /admin/audit (review B-8). Fail closed, like patient-data audit: call it inside the change's
 * transaction so a change is never kept without its entry.
 */
export async function recordAdminAction(source: string, actor: Pick<Actor, 'id' | 'email'> & { kind?: string }, a: AdminAction, at: { tenantId?: string; requestId?: string | null } = {}) {
  const id = a.resourceId && UUID.test(a.resourceId) ? a.resourceId : null;
  const changes = [...(id || !a.resourceId ? [] : [a.resourceId.slice(0, 40)]), ...(a.changes ?? [])].slice(0, 40).map((c) => c.slice(0, 40));
  const body = {
    source,
    entries: [{
      actorId: actor.id, actorKind: actor.kind === 'patient' ? 'patient' : actor.kind === 'system' ? 'system' : 'staff', actorName: actor.email ?? null,
      action: a.action, resourceType: a.resourceType, resourceId: id, patientId: null, purpose: 'ADMIN',
      requestId: at.requestId ?? RequestContext.current()?.requestId ?? null, ip: null, changes: changes.length ? changes : null,
    }],
  };
  const res = await fetch(`${process.env.SVC_URL_AUDIT ?? 'http://localhost:4411'}/internal/tenants/${at.tenantId ?? TenantContext.require().id}/audit`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!res?.ok) throw new DomainError(503, 'AUDIT_UNAVAILABLE', 'the audit log is unavailable, so the change was not made; try again');
}

const AUDITED = 'mc:admin-audited';
interface AuditedOpts { action?: AdminAction['action']; idParam?: string; keyParam?: string }

/**
 * Records a successful admin change (any method but GET) in the audit log (review B-8): who, what kind of thing, which
 * one (route param `idParam`, default `id`/`code`/`key`, or the response's `id`), and which fields the request sent
 * (names only). Written after the change succeeds; if the audit log is down the entry is retried in the background
 * rather than failing a change that has already been made. Use recordAdminAction inside the transaction where a
 * change must not happen without its entry.
 */
export const AdminAudited = (resourceType: string, opts: AuditedOpts = {}) =>
  applyDecorators(SetMetadata(AUDITED, { resourceType, ...opts }), UseInterceptors(AdminAuditInterceptor));

@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly log = new Logger('AdminAudit');
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<{ resourceType: string } & AuditedOpts>(AUDITED, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest<{ method?: string; params?: Record<string, string>; body?: unknown; routeOptions?: { url?: string } }>();
    const method = String(req.method ?? 'GET').toUpperCase();
    if (!meta || method === 'GET' || method === 'HEAD') return next.handle();
    const rc = RequestContext.current(); // taken now: the actor is known once the guards have run
    return next.handle().pipe(mergeMap((out) => from(this.record(rc, meta, method, req, out).then(() => out))));
  }

  private async record(rc: RequestContext | undefined, meta: { resourceType: string } & AuditedOpts, method: string, req: { params?: Record<string, string>; body?: unknown }, out: unknown) {
    if (!rc?.tenant || !rc.actor) return;
    const p = req.params ?? {};
    const idParam = meta.idParam ?? ['id', 'code', 'key'].find((k) => p[k]) ?? Object.keys(p).find((k) => k !== 'tenantId');
    const resourceId = (idParam && p[idParam]) || (out && typeof out === 'object' && 'id' in out ? String((out as { id: unknown }).id) : null);
    const action = meta.action ?? (method === 'DELETE' ? 'DELETE' : method === 'POST' && !idParam ? 'CREATE' : 'UPDATE');
    const fields = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body).filter((k) => k !== 'idempotencyKey') : [];
    const extra = meta.keyParam && p[meta.keyParam] ? [p[meta.keyParam]] : [];
    const entry: AdminAction = { action, resourceType: meta.resourceType, resourceId, changes: [...extra, ...fields] };
    const at = { tenantId: rc.tenant.id, requestId: rc.requestId };
    const actor = { id: rc.actor.id, email: rc.actor.email, kind: rc.actor.kind };
    try {
      await recordAdminAction(process.env.SERVICE_NAME ?? 'admin', actor, entry, at);
    } catch {
      this.log.warn(`audit log unavailable: ${meta.resourceType} ${action} by ${actor.id} will be retried`);
      void (async () => {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
          if (await recordAdminAction(process.env.SERVICE_NAME ?? 'admin', actor, entry, at).then(() => true, () => false)) return;
        }
        this.log.error(`gave up recording ${meta.resourceType} ${action} by ${actor.id}`);
      })();
    }
  }
}
