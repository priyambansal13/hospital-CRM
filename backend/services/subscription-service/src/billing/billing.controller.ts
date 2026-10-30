import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { AdminAudited, CurrentActor, Internal, notFound, parse } from '@mc/nest-common';
import { type Actor, TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { BillingService } from './billing.service.js';
import { UsageService } from './usage.service.js';

const Uuid = z.uuid();
const Code = z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,39}$/);
const CardSession = z.object({ returnUrl: z.url().max(500) });
const ChangePlan = z.object({ plan: Code, addons: z.array(z.object({ code: Code, quantity: z.number().int().min(1).max(100).optional() })).max(20).default([]) });
const Coupon = z.object({ code: z.string().trim().min(3).max(30) });
const Cancel = z.object({ cancel: z.boolean() });
const who = (a: Actor) => a.email ?? a.id;

/** The hospital's own MediCare subscription (zone /account): the account owner pays, changes plan, sees usage. */
@Controller('v1/account')
@RequireModule('core')
@AdminAudited('SUBSCRIPTION')
@RequirePermission('subscription:manage:tenant')
export class AccountController {
  constructor(private readonly billing: BillingService, private readonly usage: UsageService) {}
  private tid() { return TenantContext.require().id; }

  @Get('subscription')
  summary() { return this.billing.summary(this.tid()); }

  @Get('plans')
  plans() { return this.billing.comparePlans(this.tid()); }

  @Post('change-plan')
  changePlan(@Body() body: unknown, @CurrentActor() a: Actor) { return this.billing.changePlan(this.tid(), parse(ChangePlan, body), who(a)); }

  /** Add a card on the payment gateway's own page (review B-6): returns the page to send the owner to. */
  @Post('card-session')
  cardSession(@Body() body: unknown, @CurrentActor() a: Actor) { return this.billing.startCardSession(this.tid(), parse(CardSession, body).returnUrl, who(a)); }

  @Post('card-session/:id/complete')
  @HttpCode(200)
  completeCard(@Param('id') id: string, @CurrentActor() a: Actor) { return this.billing.completeCardSession(this.tid(), Uuid.parse(id), who(a)); }

  @Post('pay')
  pay(@CurrentActor() a: Actor) { return this.billing.payNow(this.tid(), who(a)); }

  @Post('coupon')
  coupon(@Body() body: unknown, @CurrentActor() a: Actor) { return this.billing.applyCoupon(this.tid(), parse(Coupon, body).code, who(a)); }

  @Post('cancel')
  cancel(@Body() body: unknown, @CurrentActor() a: Actor) { return this.billing.cancel(this.tid(), parse(Cancel, body).cancel, who(a)); }

  @Get('invoices')
  invoices() { return this.billing.invoices(this.tid()); }

  @Get('invoices/:id')
  invoice(@Param('id') id: string) { return this.billing.invoiceDetail(this.tid(), id); }

  @Get('usage')
  meters() { return this.usage.meters(this.tid()); }
}

const tenant = (id: string) => { if (!Uuid.safeParse(id).success) throw notFound('hospital'); return id; };

/** CLI and tests: the billing clock (dev only), runs on demand. */
@Controller('internal')
export class InternalBillingController {
  constructor(private readonly billing: BillingService, private readonly usage: UsageService) {}

  @Get('tenants/:tenantId/billing')
  @Internal()
  async show(@Param('tenantId') id: string) {
    return { ...(await this.billing.summary(tenant(id))), invoices: await this.billing.invoices(id) };
  }

  @Post('tenants/:tenantId/billing/reset-trial')
  @Internal()
  @HttpCode(200)
  async resetTrial(@Param('tenantId') id: string, @Body() body: unknown) {
    await this.billing.resetTrial(tenant(id), parse(z.object({ days: z.number().int().min(1).max(90).default(14) }), body ?? {}).days);
    return this.billing.summary(id);
  }

  @Post('tenants/:tenantId/billing/advance')
  @Internal()
  @HttpCode(200)
  advance(@Param('tenantId') id: string, @Body() body: unknown) {
    return this.billing.advance(tenant(id), parse(z.object({ to: z.string().regex(/^(trial-end|period-end|next-retry|grace-end|\+\d{1,3}d)$/) }), body).to);
  }

  @Post('billing/tick')
  @Internal()
  @HttpCode(200)
  async tick() { return { due: await this.billing.tickAll() }; }

  @Post('usage/flush')
  @Internal()
  @HttpCode(200)
  async flush() { return { flushed: await this.usage.flush() }; }
}
