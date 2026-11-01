import { Body, Controller, Get, Header, HttpCode, Inject, Injectable, Param, Post, Query, type OnModuleInit } from '@nestjs/common';
import { Topics } from '@mc/contracts';
import { EntitlementsClient, RequireFeature, RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { ConsumerRegistry, CurrentActor, Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { AnalyticsService, PERMISSION } from './semantic/analytics.service.js';
import { BriefFacts } from './semantic/brief.js';
import { MetricQuery } from './semantic/metrics.js';
import { Backfill } from './warehouse/backfill.js';
import { WAREHOUSE_EVENTS, WarehouseLoader } from './warehouse/loader.js';

const Range = z.object({ from: z.iso.date(), to: z.iso.date(), branchId: z.uuid().optional() }).refine((r) => r.from <= r.to, { message: 'from must not be after to' })
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 400, { message: 'at most 400 days at a time' });
const CsvQuery = z.object({
  metric: z.string(), from: z.string(), to: z.string(), groupBy: z.string().optional(), branchId: z.string().optional(), doctorId: z.string().optional(), specialty: z.string().optional(),
});
const uuid = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };

/** The semantic layer for people (dashboards, explore, CSV) and for the Ops agent (with the admin's own token). */
@Controller('v1/analytics')
@RequireModule('analytics')
@RequirePermission(PERMISSION)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('catalog') catalog() { return this.analytics.catalog(); }

  @Post('query')
  @HttpCode(200)
  query(@Body() body: unknown, @CurrentActor() actor: Actor) { return this.analytics.query(actor, parse(MetricQuery, body)); }

  @Get('summary')
  summary(@Query() q: unknown, @CurrentActor() actor: Actor) {
    const r = parse(Range, q);
    return this.analytics.summary(actor, r.from, r.to, r.branchId);
  }

  @Get('status') status() { return this.analytics.asOf(); }

  @Get('export.csv')
  @RequireFeature('analytics.export')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="medicare-report.csv"')
  @Header('cache-control', 'no-store')
  csv(@Query() q: unknown, @CurrentActor() actor: Actor) {
    const c = parse(CsvQuery, q);
    const filters = Object.fromEntries(Object.entries({ branchId: c.branchId, doctorId: c.doctorId, specialty: c.specialty }).filter(([, v]) => v));
    return this.analytics.csv(actor, parse(MetricQuery, { metric: c.metric, from: c.from, to: c.to, groupBy: c.groupBy || undefined, filters, limit: 100 }));
  }
}

/** Operations: (re)load a hospital's warehouse; the facts for a branch's daily brief (ai-assistant-service). */
@Controller('internal/tenants/:tenantId/analytics')
export class InternalAnalyticsController {
  constructor(private readonly backfill: Backfill, private readonly brief: BriefFacts, private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post('backfill')
  @Internal()
  @HttpCode(200)
  async load(@Param('tenantId') t: string) { return this.backfill.start(await this.placements.get(uuid(t, 'tenant'))); }

  @Post('refresh')
  @Internal()
  @HttpCode(200)
  async refresh(@Param('tenantId') t: string) { await this.backfill.refresh(await this.placements.get(uuid(t, 'tenant'))); return { ok: true }; }

  /** Active branches with their local hour and day (the brief job sends each branch's brief from 7 a.m. its time). */
  @Get('branches')
  @Internal()
  async branches(@Param('tenantId') t: string) {
    return TenantContext.run(await this.placements.get(uuid(t, 'tenant')), async () => (await this.db.query(
      `SELECT id, name, extract(hour FROM now() AT TIME ZONE timezone)::int local_hour, (now() AT TIME ZONE timezone)::date::text today FROM dim_branches WHERE active ORDER BY name`)).rows
      .map((r) => ({ id: r.id, name: r.name, localHour: r.local_hour, today: r.today })));
  }

  @Get('brief/:branchId')
  @Internal()
  async briefFor(@Param('tenantId') t: string, @Param('branchId') b: string) { return this.brief.forBranch(await this.placements.get(uuid(t, 'tenant')), uuid(b, 'branch')); }
}

/** Domain events → warehouse (only for hospitals with the analytics module; the backfill covers what came before). */
@Injectable()
export class WarehouseConsumers implements OnModuleInit {
  constructor(private readonly registry: ConsumerRegistry, private readonly loader: WarehouseLoader, private readonly entitlements: EntitlementsClient) {}
  onModuleInit() {
    const handle = async (e: any, db: any) => {
      // entitlement-service unreachable (e.g. still starting): keep the row rather than lose the event
      const state = await this.entitlements.moduleState(TenantContext.require().id, 'analytics').catch(() => 'ACTIVE');
      if (state !== 'ACTIVE') return;
      await this.loader.onEvent(db!, e);
    };
    this.registry.register({
      group: 'analytics.warehouse',
      topics: [Topics.tenant, Topics.provider, Topics.scheduling, Topics.patient, Topics.billing, Topics.diagnostics],
      handlers: Object.fromEntries(WAREHOUSE_EVENTS.map((t) => [t, handle])),
    });
  }
}
