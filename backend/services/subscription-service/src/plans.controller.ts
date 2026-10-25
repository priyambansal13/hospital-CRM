import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { EventTypes, TenantProvisioned, TenantUpdated, Topics } from '@mc/contracts';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { ConsumerRegistry, Internal, notFound, parse, PLACEMENTS, TenantPublic } from '@mc/nest-common';
import { type PlacementSource, TenantContext } from '@mc/tenancy';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { PLATFORM_SLUG, PlansService } from './plans.service.js';
import { BillingService } from './billing/billing.service.js';

const Uuid = z.uuid();
const Key = z.string().regex(/^[a-z_]{2,40}$/);
const Change = z.object({
  plan: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/),
  version: z.number().int().positive().optional(),
  addons: z.array(z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/), quantity: z.number().int().min(1).max(100).optional() })).max(20).default([]),
  by: z.string().trim().min(2).max(120),
  reason: z.string().trim().min(3).max(300),
});
const Override = z.object({ state: z.enum(['on', 'off', 'plan']), by: z.string().trim().min(2).max(120) });
const Upsell = z.object({ module: Key.optional(), feature: z.string().regex(/^[a-z_]+\.[a-z_]+$/).optional() }).refine((q) => !!q.module !== !!q.feature, 'module or feature');

/** The hospital's own view: its plan, modules and limits, and what an upgrade would unlock. */
@Controller('v1')
@RequireModule('core')
export class PlanController {
  constructor(private readonly plans: PlansService) {}

  @Get('plan')
  @RequirePermission('plan:read:tenant')
  async plan() {
    const t = TenantContext.require();
    const cur = await this.plans.current(t.id);
    const names = new Map([...this.plans.modules.modules.values()].map((m) => [m.key, m]));
    return {
      plan: { code: cur.plan.code, name: cur.plan.name, tier: cur.plan.tier, edition: cur.plan.editionName, version: cur.plan.version, listPrice: cur.plan.listPrice },
      addons: cur.addons.map((a) => ({ code: a.code, name: a.name, quantity: a.quantity })),
      since: cur.since,
      modules: cur.effective.modules.map((m) => ({ key: m.key, name: names.get(m.key)?.name ?? m.key, source: m.source })),
      features: [...names.values()].flatMap((m) => m.features.filter((f) => cur.effective.features[f.key]).map((f) => ({ key: f.key, name: f.name, type: f.type, unit: f.unit ?? null, module: m.key, ...cur.effective.features[f.key] }))),
      settingBounds: cur.effective.settingBounds,
    };
  }

  /** The cheapest add-on or plan that unlocks a module or feature (any signed-in user of the hospital may ask). */
  @Get('upsell')
  upsell(@Query() q: unknown) {
    return this.plans.upsell(TenantContext.require().id, parse(Upsell, q));
  }

  /** MediCare's published plans (the public pricing page is generated from these in Phase 20). */
  @Get('plans')
  @TenantPublic()
  async catalogue() {
    const names = new Map([...this.plans.modules.modules.values()].map((m) => [m.key, m.name]));
    return (await this.plans.plans()).map((p) => ({ code: p.code, name: p.name, tier: p.tier, edition: p.editionName, listPrice: p.listPrice, trialDays: p.trialDays, modules: p.modules.map((k) => ({ key: k, name: names.get(k) ?? k })), features: p.features, addons: p.addonCodes }));
  }
}

/** Platform CLI / console (Phase 18): plans, contracts and overrides per hospital. Not reachable through the gateway. */
@Controller('internal')
export class InternalPlansController {
  constructor(private readonly plans: PlansService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  private async tenant(id: string) {
    if (!Uuid.safeParse(id).success) throw notFound('tenant');
    return (await this.placements.get(id)).id;
  }

  @Get('plans')
  @Internal()
  async list() {
    return { plans: await this.plans.plans(), addons: await this.plans.addonList() };
  }

  @Get('tenants/:tenantId/contract')
  @Internal()
  async contract(@Param('tenantId') tenantId: string) {
    const id = await this.tenant(tenantId);
    return { ...(await this.plans.current(id)), seq: await this.plans.seq(id), history: await this.plans.history(id) };
  }

  @Put('tenants/:tenantId/contract')
  @Internal()
  async change(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    const id = await this.tenant(tenantId);
    return this.plans.change(id, { ...parse(Change, body), allowInternal: (await this.plans.slug(id)) === PLATFORM_SLUG });
  }

  @Put('tenants/:tenantId/overrides/modules/:key')
  @Internal()
  async override(@Param('tenantId') tenantId: string, @Param('key') key: string, @Body() body: unknown) {
    const { state, by } = parse(Override, body);
    return this.plans.overrideModule(await this.tenant(tenantId), parse(Key, key), state, by);
  }

  @Post('tenants/:tenantId/republish')
  @Internal()
  @HttpCode(202)
  async republish(@Param('tenantId') tenantId: string) {
    await this.plans.republish(await this.tenant(tenantId));
    return { ok: true };
  }
}

@Injectable()
export class SubscriptionConsumers implements OnModuleInit {
  constructor(private readonly registry: ConsumerRegistry, private readonly plans: PlansService, private readonly billing: BillingService) {}
  onModuleInit() {
    this.registry.register({
      group: 'subscription.tenants',
      topics: [Topics.tenant],
      handlers: {
        [EventTypes.tenantProvisioned]: async (evt) => {
          const d = TenantProvisioned.parse(evt.data);
          await this.plans.onTenantProvisioned(d.tenantId, d.slug, d.plan);
          await this.billing.ensure(d.tenantId, { signup: d.source === 'SIGNUP' }); // self-serve: free trial; sales-led: invoiced
        },
        // a hospital closed down by MediCare: its subscription ends (nothing more is billed)
        [EventTypes.tenantUpdated]: async (evt) => {
          const d = TenantUpdated.parse(evt.data);
          if (d.status === 'DELETED') await this.billing.close(d.tenantId);
        },
      },
    });
  }
}
