import { Body, type CanActivate, Controller, Get, Header, HttpCode, Injectable, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { clientIp, CurrentActor, Internal, notFound, parse, Public } from '@mc/nest-common';
import { PhoneNumber } from '@mc/contracts';
import { type Actor, TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { Attribution } from './attribution.js';
import { GrowthJob } from './growth.job.js';
import { GrowthService } from './growth.service.js';

const PLATFORM_SLUG = process.env.PLATFORM_TENANT_SLUG ?? 'medicare';

const Lead = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().max(160),
  phone: PhoneNumber.nullable().default(null),
  hospitalName: z.string().trim().min(2).max(120),
  city: z.string().trim().max(60).nullable().default(null),
  segment: z.enum(['CLINIC', 'DIAGNOSTIC', 'HOSPITAL', 'DENTAL', 'EYE', 'OTHER']),
  doctors: z.number().int().min(0).max(100000).nullable().default(null),
  message: z.string().trim().max(1000).nullable().default(null),
  attribution: Attribution,
});
const LeadPatch = z.object({ status: z.enum(['NEW', 'CONTACTED', 'DEMO_DONE', 'WON', 'LOST']).optional(), note: z.string().trim().max(500).nullable().optional() });
const Days = z.coerce.number().int().min(1).max(365).default(90);

/** "Book a demo" on MediCare's marketing site (no hospital, no sign-in): rate-limited per e-mail and network. */
@Controller('v1/leads')
export class LeadsController {
  constructor(private readonly growth: GrowthService) {}

  @Post()
  @Public()
  create(@Body() body: unknown, @Req() req: { headers: Record<string, string | undefined>; ip?: string }) {
    return this.growth.createLead(parse(Lead, body), clientIp(req));
  }
}

/** Only MediCare's own account has the console; anyone else gets 404. */
@Injectable()
class HqOnly implements CanActivate {
  canActivate() {
    if (TenantContext.require().slug !== PLATFORM_SLUG) throw notFound();
    return true;
  }
}

/** The console's growth page (/platform/growth): the funnel by channel, demo requests, conversion exports. */
@Controller('v1/platform/growth')
@UseGuards(HqOnly)
@RequireModule('platform')
@RequirePermission('platform_console:access:tenant')
export class GrowthConsoleController {
  constructor(private readonly growth: GrowthService) {}

  @Get('funnel')
  @RequirePermission('customer:read:tenant')
  funnel(@Query('days') days: unknown) { return this.growth.funnel(parse(Days, days)); }

  @Get('leads')
  @RequirePermission('customer:read:tenant')
  leads(@Query('status') status: unknown) { return this.growth.leads(parse(LeadPatch.shape.status, status ?? undefined)); }

  @Patch('leads/:id')
  @RequirePermission('customer:manage:tenant')
  update(@Param('id') id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    if (!z.uuid().safeParse(id).success) throw notFound('lead');
    return this.growth.updateLead(id, parse(LeadPatch, body), a.email ?? a.id);
  }

  @Get('conversions/google.csv')
  @RequirePermission('customer:manage:tenant')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="medicare-conversions.csv"')
  google(@Query('days') days: unknown) { return this.growth.googleCsv(parse(Days, days)); }
}

/** Tests and the CLI: run the growth job now. */
@Controller('internal/growth')
export class InternalGrowthController {
  constructor(private readonly job: GrowthJob) {}

  @Post('run')
  @Internal()
  @HttpCode(200)
  run() { return this.job.runOnce(); }
}
