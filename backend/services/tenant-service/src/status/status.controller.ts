import { Body, type CanActivate, Controller, Get, Header, Injectable, Param, Post, UseGuards } from '@nestjs/common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { CurrentActor, notFound, parse, Public } from '@mc/nest-common';
import { type Actor, TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { COMPONENT_KEYS, StatusService } from './status.service.js';

const PLATFORM_SLUG = process.env.PLATFORM_TENANT_SLUG ?? 'medicare';
const Status = z.enum(['SCHEDULED', 'INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED']);
const NewIncident = z.object({
  title: z.string().trim().min(3).max(160),
  impact: z.enum(['MINOR', 'MAJOR', 'CRITICAL', 'MAINTENANCE']),
  components: z.array(z.enum(COMPONENT_KEYS as [string, ...string[]])).min(1),
  status: Status.default('INVESTIGATING'),
  message: z.string().trim().min(3).max(2000),
  startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  endsAt: z.iso.datetime({ offset: true }).nullable().default(null),
}).refine((i) => i.status !== 'SCHEDULED' || i.impact === 'MAINTENANCE', 'only planned maintenance can be SCHEDULED');
const Update = z.object({ status: Status, message: z.string().trim().min(3).max(2000) });

/** The public status (no sign-in, no hospital): what works right now, open incidents, the last two weeks. */
@Controller('v1/status')
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get()
  @Public()
  @Header('cache-control', 'public, max-age=30')
  get() { return this.status.status(); }
}

@Injectable()
class HqOnly implements CanActivate {
  canActivate() {
    if (TenantContext.require().slug !== PLATFORM_SLUG) throw notFound();
    return true;
  }
}

/** Console (/platform/status): MediCare support posts incidents and planned maintenance, and their updates. */
@Controller('v1/platform/status')
@UseGuards(HqOnly)
@RequireModule('platform')
@RequirePermission('platform_console:access:tenant')
export class StatusConsoleController {
  constructor(private readonly status: StatusService) {}

  @Get('incidents')
  @RequirePermission('customer:read:tenant')
  list() { return this.status.list(); }

  @Post('incidents')
  @RequirePermission('status:manage:tenant')
  create(@Body() body: unknown, @CurrentActor() a: Actor) { return this.status.create(parse(NewIncident, body), a.email ?? a.id); }

  @Post('incidents/:id/updates')
  @RequirePermission('status:manage:tenant')
  update(@Param('id') id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    if (!z.uuid().safeParse(id).success) throw notFound('incident');
    return this.status.update(id, parse(Update, body), a.email ?? a.id);
  }
}
