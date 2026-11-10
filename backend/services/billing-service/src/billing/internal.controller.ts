import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { SimulatedRazorpay } from '../gateway/simulator.js';
import { BillingService } from './billing.service.js';

const OpenOnline = z.object({
  sourceType: z.enum(['APPOINTMENT', 'LAB_ORDER']), sourceId: z.uuid(), patientId: z.uuid(), patientName: z.string().min(1), patientMrn: z.string().min(1),
  accountPersonId: z.uuid(), branchId: z.uuid(), branchName: z.string(), description: z.string().max(300), amount: z.number().positive(), expiresAt: z.iso.datetime({ offset: true }),
});

/** Service-to-service: scheduling opens the invoice + gateway order for an online booking. */
@Controller('internal/tenants/:tenantId/invoices')
export class InternalInvoicesController {
  constructor(private readonly billing: BillingService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post('online')
  @Internal()
  async online(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    const input = parse(OpenOnline, body);
    return TenantContext.run(await this.placements.get(tenantId), () => this.billing.openOnline(input));
  }
}

/** Chaos tests, dev only: make the simulated payment provider unavailable for a while (`seconds: 0` ends it). */
@Controller('internal/simulator')
export class InternalSimulatorController {
  constructor(private readonly billing: BillingService) {}

  @Post('outage')
  @Internal()
  @HttpCode(200)
  async outage(@Body() body: unknown) {
    if (!(this.billing.gateway instanceof SimulatedRazorpay)) throw notFound('route');
    const { seconds } = parse(z.object({ seconds: z.number().int().min(0).max(3600) }), body);
    await this.billing.gateway.setOutage(seconds);
    return { outage: seconds > 0, seconds };
  }
}
