import { Controller, HttpCode, Inject, Injectable, Optional, Param, Post } from '@nestjs/common';
import { type PlacementSource, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { Internal, PLACEMENTS } from './auth/auth.js';
import { notFound } from './errors.js';

export interface ModuleHook {
  /** module switched on for a hospital: seed its data, prepare what its jobs need. Must be idempotent. */
  enable?: (c: Queryable) => Promise<void>;
  /** module switched off: data is kept (read-only); stop anything that would create new work. Must be idempotent. */
  disable?: (c: Queryable) => Promise<void>;
}

/** Services register what happens when one of their modules is switched on/off (docs/PRODUCT-MODULES-AND-PLANS.md §8). */
@Injectable()
export class ModuleHooks {
  private readonly hooks = new Map<string, ModuleHook>();
  register(module: string, hook: ModuleHook) {
    this.hooks.set(module, hook);
  }
  get(module: string) {
    return this.hooks.get(module);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Called by entitlement-service for each service listed in a manifest's `lifecycle`, retried until it succeeds.
 * A module with no hook in this service is a no-op success.
 */
@Controller('internal/tenants/:tenantId/modules')
export class ModuleHooksController {
  constructor(
    private readonly hooks: ModuleHooks,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource,
    @Optional() @Inject(TenantDbRouter) private readonly router?: TenantDbRouter,
  ) {}

  @Post(':key/:action')
  @Internal()
  @HttpCode(200)
  async run(@Param('tenantId') tenantId: string, @Param('key') key: string, @Param('action') action: string) {
    if (!UUID.test(tenantId) || (action !== 'enable' && action !== 'disable')) throw notFound();
    const tenant = await this.placements.get(tenantId);
    const fn = this.hooks.get(key)?.[action];
    if (!fn || !this.router) return { module: key, action, ran: false };
    await TenantContext.run(tenant, () => this.router!.tx((c) => fn(c)));
    return { module: key, action, ran: true };
  }
}
