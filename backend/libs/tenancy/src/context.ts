import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActorKind, TenantPlacement } from '@mc/contracts';

export interface Actor {
  id: string;
  kind: ActorKind;
  email?: string;
  /** raw bearer token, forwarded when this service calls another on the user's behalf */
  token: string;
}

/** Mutable per-request context: created by an onRequest hook, filled in by the auth guard. */
export interface RequestContext {
  requestId: string;
  tenant?: TenantPlacement;
  actor?: Actor;
}

const als = new AsyncLocalStorage<RequestContext>();

export const RequestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return als.run(ctx, fn);
  },
  current(): RequestContext | undefined {
    return als.getStore();
  },
};

export class NoTenantContextError extends Error {
  constructor() {
    super('no tenant in context: tenant-scoped code ran outside a tenant request/event');
  }
}

/** Repositories call TenantContext.require() so they can never run without a tenant. */
export const TenantContext = {
  require(): TenantPlacement {
    const t = als.getStore()?.tenant;
    if (!t) throw new NoTenantContextError();
    return t;
  },
  optional(): TenantPlacement | undefined {
    return als.getStore()?.tenant;
  },
  /** Run fn with the given tenant (background jobs and event consumers). */
  run<T>(tenant: TenantPlacement, fn: () => T, requestId = `job-${tenant.slug}`): T {
    return als.run({ requestId, tenant }, fn);
  },
};
