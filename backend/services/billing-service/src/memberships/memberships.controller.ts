import { Body, Controller, Get, HttpCode, Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit, Param, Patch, Post } from '@nestjs/common';
import { EventTypes, MembershipBenefits, PaymentSucceeded, Topics } from '@mc/contracts';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { ConsumerRegistry, CurrentActor, Internal, ModuleHooks, notFound, parse, PLACEMENTS, TenantPublic } from '@mc/nest-common';
import { type Actor, type PlacementSource, TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { MembershipsService } from './memberships.service.js';

const id = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };
const Plan = z.object({
  code: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z][A-Z0-9_]{1,30}$/, 'letters, digits and _')),
  name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).nullable().default(null),
  price: z.number().positive().max(1_000_000), period: z.enum(['MONTHLY', 'YEARLY']), benefits: MembershipBenefits,
  active: z.boolean().default(true), sort: z.number().int().min(0).max(100).default(0),
});
const PlanPatch = Plan.omit({ code: true }).partial().extend({ version: z.number().int() });

/** Admin: the hospital's membership tiers and its members. */
@Controller('v1/membership-plans')
@RequireModule('memberships')
@RequirePermission('membership:manage:tenant')
export class MembershipPlansController {
  constructor(private readonly m: MembershipsService) {}
  @Get() list() { return this.m.plans(false); }
  @Post() create(@Body() body: unknown) { return this.m.createPlan(parse(Plan, body)); }
  @Patch(':id') update(@Param('id') p: string, @Body() body: unknown) { return this.m.updatePlan(id(p, 'membership tier'), parse(PlanPatch, body)); }
}

@Controller('v1/members')
@RequireModule('memberships')
@RequirePermission('membership:manage:tenant')
export class MembersController {
  constructor(private readonly m: MembershipsService) {}
  @Get() list() { return this.m.members(); }
}

/** Patients: compare tiers (public), see their own, join or renew. */
@Controller('v1')
@RequireModule('memberships')
export class MyMembershipController {
  constructor(private readonly m: MembershipsService) {}

  @Get('public/membership-plans')
  @TenantPublic()
  publicPlans() { return this.m.plans(true); }

  @Get('me/membership')
  @RequirePermission('membership:buy:own')
  mine(@CurrentActor() actor: Actor) { return this.m.mine(actor); }

  @Post('memberships')
  @RequirePermission('membership:buy:own')
  @HttpCode(201)
  buy(@Body() body: unknown, @CurrentActor() actor: Actor) { return this.m.buy(actor, parse(z.object({ planId: z.uuid() }), body).planId); }
}

/** Scheduling and diagnostics ask what an account's membership gives (short cache on their side). */
@Controller('internal/tenants/:tenantId/members')
export class InternalMembersController {
  constructor(private readonly m: MembershipsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}
  @Get(':personId')
  @Internal()
  async benefits(@Param('tenantId') t: string, @Param('personId') p: string) {
    id(t, 'tenant');
    return TenantContext.run(await this.placements.get(t), () => this.m.benefitsFor(id(p, 'person')));
  }
}

/** Template tiers when the module is switched on; activation on payment; hourly expiry. */
@Injectable()
export class MembershipJobs implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Memberships');
  private timer?: NodeJS.Timeout;
  constructor(private readonly hooks: ModuleHooks, private readonly registry: ConsumerRegistry, private readonly m: MembershipsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  onModuleInit() {
    this.hooks.register('memberships', { enable: (c) => this.m.seed(c) });
    this.registry.register({
      group: 'billing.memberships',
      topics: [Topics.billing],
      handlers: { [EventTypes.paymentSucceeded]: (e, db) => this.m.onPaid(db!, PaymentSucceeded.parse(e.data)) },
    });
  }

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => void this.run(), Number(process.env.MEMBERSHIP_EXPIRY_MS ?? 60 * 60_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async run() {
    for (const t of await this.placements.list()) {
      if (t.status !== 'ACTIVE') continue;
      await TenantContext.run(t, () => this.m.expire()).catch(() => 0);
    }
  }
}
