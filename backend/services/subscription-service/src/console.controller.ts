import { Body, type CanActivate, Controller, Delete, Get, HttpCode, Injectable, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { CurrentActor, DomainError, notFound, parse } from '@mc/nest-common';
import { type Actor, TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { BuilderService, type Who } from './builder.service.js';
import { PLATFORM_SLUG, PlansService } from './plans.service.js';
import { BillingService } from './billing/billing.service.js';

/**
 * Defence in depth: only MediCare's own account may use the console, even if another hospital somehow had the
 * platform module. Everyone else gets 404 (the console does not exist for them).
 */
@Injectable()
class HqOnly implements CanActivate {
  canActivate() {
    if (TenantContext.require().slug !== PLATFORM_SLUG) throw notFound();
    return true;
  }
}

const Uuid = z.uuid();
const Code = z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,39}$/, 'CAPITALS_AND_UNDERSCORES, 3–40 characters');
const ModuleKey = z.string().regex(/^[a-z_]{2,40}$/);
const FeatureKey = z.string().regex(/^[a-z_]+\.[a-z_]+$/);
const Edition = z.object({ code: Code, name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).nullable().default(null) });
const NewPlan = z.object({ code: Code, name: z.string().trim().min(2).max(80), edition: Code, tier: z.string().trim().min(2).max(40), description: z.string().trim().max(300).nullable().default(null), copyFrom: Code.nullable().default(null) });
const Draft = z.object({
  listPrice: z.number().min(0).max(10_000_000),
  trialDays: z.number().int().min(0).max(365).default(0),
  modules: z.array(ModuleKey).max(50),
  features: z.record(FeatureKey, z.object({ enabled: z.boolean(), limit: z.number().int().min(0).max(1_000_000_000).nullable(), overage: z.enum(['BLOCK', 'SOFT_WARN', 'ALLOW_BILL']).nullable().optional() })).default({}),
  settings: z.record(FeatureKey, z.object({ min: z.number().nullable().optional(), max: z.number().nullable().optional(), allowed: z.array(z.string()).nullable().optional() })).default({}),
  addons: z.array(Code).max(30).default([]),
});
const Approve = z.object({ migration: z.enum(['NEW_ONLY', 'MIGRATE_NOW']).default('NEW_ONLY'), note: z.string().trim().max(300).nullable().default(null) });
const Reject = z.object({ note: z.string().trim().min(3).max(300) });
const Addons = z.array(z.object({ code: Code, quantity: z.number().int().min(1).max(100).optional() })).max(20).default([]);
const Assign = z.object({ plan: Code, addons: Addons, reason: z.string().trim().min(3).max(300) });
const Simulate = z.object({ versionId: z.uuid(), addons: Addons });
const ModuleOverride = z.object({ state: z.enum(['on', 'off', 'plan']), reason: z.string().trim().min(3).max(300) });
const FeatureOverride = z.object({ value: z.object({ enabled: z.boolean().optional(), limit: z.number().int().min(0).nullable().optional() }).nullable(), reason: z.string().trim().min(3).max(300) });
const NewCoupon = z.object({ code: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9_]{3,30}$/)), description: z.string().trim().min(3).max(120), percentOff: z.number().positive().max(100).nullable().default(null), amountOff: z.number().positive().nullable().default(null), months: z.number().int().positive().max(36).nullable().default(null), maxRedemptions: z.number().int().positive().nullable().default(null), validUntil: z.iso.date().nullable().default(null) })
  .refine((c) => !!c.percentOff !== !!c.amountOff, 'percent off or an amount off');
const OfflinePayment = z.object({ reference: z.string().trim().min(3).max(80) });
const AuditQuery = z.object({ targetType: z.enum(['PLAN', 'PLAN_VERSION', 'EDITION', 'TENANT']).optional(), targetId: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });

const who = (a: Actor): Who => ({ id: a.id, label: a.email ?? a.id });
const versionId = (id: string) => { if (!Uuid.safeParse(id).success) throw notFound('plan version'); return id; };

/** MediCare platform console API (zone /platform): registry, editions, plan builder, hospitals' contracts, audit. */
@Controller('v1/platform')
@UseGuards(HqOnly)
@RequireModule('platform')
@RequirePermission('platform_console:access:tenant')
export class ConsoleController {
  constructor(private readonly builder: BuilderService, private readonly plans: PlansService, private readonly billing: BillingService) {}

  private async tenant(id: string) {
    if (!Uuid.safeParse(id).success) throw notFound('hospital');
    // a hospital created moments ago may not be in the cached list yet: look again before saying "not found"
    const t = (await this.builder.hospitals()).find((h) => h.id === id) ?? (await this.builder.hospitals({ fresh: true })).find((h) => h.id === id);
    if (!t) throw notFound('hospital');
    return t;
  }

  // ---- catalogue
  @Get('registry')
  @RequirePermission('catalog:read:tenant')
  registry() {
    return this.builder.registry();
  }

  @Get('editions')
  @RequirePermission('catalog:read:tenant')
  editions() {
    return this.builder.editions();
  }

  @Post('editions')
  @RequirePermission('catalog:edit:tenant')
  saveEdition(@Body() body: unknown, @CurrentActor() a: Actor) {
    return this.builder.saveEdition(who(a), parse(Edition, body));
  }

  @Get('addons')
  @RequirePermission('catalog:read:tenant')
  addons() {
    return this.plans.addonList();
  }

  @Get('plans')
  @RequirePermission('catalog:read:tenant')
  listPlans() {
    return this.builder.listPlans();
  }

  @Post('plans')
  @RequirePermission('catalog:edit:tenant')
  createPlan(@Body() body: unknown, @CurrentActor() a: Actor) {
    return this.builder.createPlan(who(a), parse(NewPlan, body));
  }

  @Post('plans/:code/versions')
  @RequirePermission('catalog:edit:tenant')
  newVersion(@Param('code') code: string, @CurrentActor() a: Actor) {
    if (!Code.safeParse(code).success) throw notFound('plan');
    return this.builder.newVersion(who(a), code);
  }

  @Get('versions/:id')
  @RequirePermission('catalog:read:tenant')
  version(@Param('id') id: string) {
    return this.builder.version(versionId(id));
  }

  @Put('versions/:id')
  @RequirePermission('catalog:edit:tenant')
  save(@Param('id') id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.builder.saveDraft(who(a), versionId(id), parse(Draft, body));
  }

  @Delete('versions/:id')
  @RequirePermission('catalog:edit:tenant')
  discard(@Param('id') id: string, @CurrentActor() a: Actor) {
    return this.builder.discard(who(a), versionId(id));
  }

  @Post('versions/:id/submit')
  @RequirePermission('catalog:edit:tenant')
  submit(@Param('id') id: string, @CurrentActor() a: Actor) {
    return this.builder.submit(who(a), versionId(id));
  }

  @Get('versions/:id/impact')
  @RequirePermission('catalog:read:tenant')
  impact(@Param('id') id: string) {
    return this.builder.impact(versionId(id));
  }

  @Post('versions/:id/approve')
  @RequirePermission('catalog:approve:tenant')
  approve(@Param('id') id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    const { migration, note } = parse(Approve, body ?? {});
    return this.builder.approve(who(a), versionId(id), migration, note);
  }

  @Post('versions/:id/reject')
  @RequirePermission('catalog:approve:tenant')
  reject(@Param('id') id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.builder.reject(who(a), versionId(id), parse(Reject, body).note);
  }

  @Post('versions/:id/retire')
  @RequirePermission('catalog:approve:tenant')
  retire(@Param('id') id: string, @CurrentActor() a: Actor) {
    return this.builder.retire(who(a), versionId(id));
  }

  // ---- hospitals
  @Get('hospitals')
  @RequirePermission('customer:read:tenant')
  hospitals() {
    return this.builder.hospitals();
  }

  @Get('hospitals/:id')
  @RequirePermission('customer:read:tenant')
  async hospital(@Param('id') id: string) {
    const t = await this.tenant(id);
    const contract = t.plan ? await this.plans.current(t.id) : null;
    return { ...t, contract, history: await this.plans.history(t.id), moduleStates: await this.builder.moduleStates(t.id), audit: await this.builder.auditLog({ targetType: 'TENANT', targetId: t.id, limit: 20 }) };
  }

  @Post('hospitals/:id/simulate')
  @RequirePermission('customer:read:tenant')
  async simulate(@Param('id') id: string, @Body() body: unknown) {
    const t = await this.tenant(id);
    const q = parse(Simulate, body);
    return this.plans.simulate(t.id, q.versionId, q.addons);
  }

  @Put('hospitals/:id/contract')
  @RequirePermission('customer:manage:tenant')
  async assign(@Param('id') id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    const t = await this.tenant(id);
    const q = parse(Assign, body);
    // the console never hands out internal plans (MediCare HQ's own): allowInternal stays off
    return this.plans.change(t.id, { plan: q.plan, addons: q.addons, by: who(a).label, reason: q.reason });
  }

  @Put('hospitals/:id/modules/:key')
  @RequirePermission('customer:manage:tenant')
  async overrideModule(@Param('id') id: string, @Param('key') key: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    const t = await this.tenant(id);
    if (t.plan?.internal) throw notFound('hospital');
    const q = parse(ModuleOverride, body);
    return this.plans.overrideModule(t.id, parse(ModuleKey, key), q.state, who(a).label, q.reason);
  }

  @Put('hospitals/:id/features/:key')
  @RequirePermission('customer:manage:tenant')
  async overrideFeature(@Param('id') id: string, @Param('key') key: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    const t = await this.tenant(id);
    if (t.plan?.internal) throw notFound('hospital');
    const q = parse(FeatureOverride, body);
    return this.plans.overrideFeature(t.id, parse(FeatureKey, key), q.value, who(a).label, q.reason);
  }

  // ---- billing
  @Get('hospitals/:id/billing')
  @RequirePermission('customer:read:tenant')
  async hospitalBilling(@Param('id') id: string) {
    return { billing: await this.billing.hospitalBilling((await this.tenant(id)).id) };
  }

  @Post('hospitals/:id/invoices/:invoiceId/paid')
  @RequirePermission('customer:manage:tenant')
  async offlinePaid(@Param('id') id: string, @Param('invoiceId') invoiceId: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    if (!Uuid.safeParse(invoiceId).success) throw notFound('invoice');
    return this.billing.recordOfflinePayment((await this.tenant(id)).id, invoiceId, parse(OfflinePayment, body).reference, who(a).label);
  }

  /** Support brings an expired or cancelled hospital back (review D-7): by card on file, or by bank transfer. */
  @Post('hospitals/:id/reactivate')
  @HttpCode(200)
  @RequirePermission('customer:manage:tenant')
  async reactivate(@Param('id') id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    const q = parse(z.object({ offline: z.boolean().default(false), reason: z.string().trim().min(5).max(300) }), body);
    return this.billing.reactivate((await this.tenant(id)).id, who(a).label, q);
  }

  // ---- support actions (review H-7)
  @Post('hospitals/:id/trial')
  @HttpCode(200)
  @RequirePermission('customer:manage:tenant')
  async extendTrial(@Param('id') id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    const q = parse(z.object({ days: z.number().int().min(1).max(60), reason: z.string().trim().min(5).max(300) }), body);
    return this.billing.extendTrial((await this.tenant(id)).id, q.days, who(a).label, q.reason);
  }

  @Post('hospitals/:id/credits')
  @RequirePermission('customer:manage:tenant')
  async credit(@Param('id') id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    const q = parse(z.object({ amount: z.number().positive().max(1_000_000), reason: z.string().trim().min(5).max(300) }), body);
    return this.billing.addCredit((await this.tenant(id)).id, q.amount, who(a).label, q.reason);
  }

  /**
   * Take a hospital offline (abuse, a legal hold, the owner's request) or bring it back; deleting needs the slug typed
   * again. Every action is in the platform audit log with the reason.
   */
  @Post('hospitals/:id/status')
  @HttpCode(200)
  @RequirePermission('customer:manage:tenant')
  async setStatus(@Param('id') id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    const t = await this.tenant(id);
    if (t.plan?.internal) throw notFound('hospital');
    const q = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']), reason: z.string().trim().min(5).max(300), confirmSlug: z.string().optional() }), body);
    if (q.status === 'DELETED' && q.confirmSlug !== t.slug) throw new DomainError(422, 'CONFIRM_SLUG', `type the hospital's slug (${t.slug}) to delete it`);
    const res = await fetch(`${process.env.SVC_URL_TENANT ?? 'http://localhost:4401'}/internal/tenants/${t.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, body: JSON.stringify({ status: q.status }),
    });
    if (!res.ok) throw new DomainError(502, 'TENANT_SERVICE', `tenant-service ${res.status}`);
    if (q.status === 'DELETED') await this.billing.close(t.id);
    await this.plans.auditOnce(who(a).label, `HOSPITAL_${q.status}`, t.id, t.slug, q.reason);
    return { id: t.id, slug: t.slug, status: q.status };
  }

  @Get('pricebook')
  @RequirePermission('catalog:read:tenant')
  priceBooks() {
    return this.billing.priceBooks();
  }

  @Post('coupons')
  @RequirePermission('catalog:edit:tenant')
  createCoupon(@Body() body: unknown, @CurrentActor() a: Actor) {
    return this.billing.createCoupon(who(a).label, parse(NewCoupon, body));
  }

  // ---- audit
  @Get('audit')
  @RequirePermission('customer:read:tenant')
  audit(@Query() q: unknown) {
    return this.builder.auditLog(parse(AuditQuery, q));
  }
}
