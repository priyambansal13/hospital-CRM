import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { LabService } from './lab.service.js';
import { ResultsService } from './results.service.js';

const id = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };
const LisResults = z.object({
  orderNo: z.string().trim().min(3).max(40), source: z.string().trim().min(1).max(60),
  results: z.array(z.object({ testCode: z.string().trim().min(1).max(40), parameter: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(80) })).min(1).max(200),
});

/**
 * integration-service (Phase 27): the FHIR API reads published reports; the LIS connector reads an order (to send it
 * to the instruments) and enters the results that come back. integration-service checks the API key and audits.
 */
@Controller('internal/tenants/:tenantId')
export class InternalIntegrationController {
  constructor(private readonly db: TenantDbRouter, private readonly lab: LabService, private readonly results: ResultsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}
  private async run<T>(t: string, fn: () => Promise<T>) { return TenantContext.run(await this.placements.get(id(t, 'tenant')), fn); }

  @Get('patients/:patientId/lab-reports')
  @Internal()
  reports(@Param('tenantId') t: string, @Param('patientId') p: string) { return this.run(t, () => this.results.publishedFor(id(p, 'patient'))); }

  @Get('lab-orders/:orderId')
  @Internal()
  order(@Param('tenantId') t: string, @Param('orderId') o: string) {
    return this.run(t, async () => {
      const c = await this.db.current();
      const row = await this.lab.row(c, id(o, 'lab order'));
      if (!row) throw notFound('lab order');
      return this.lab.dto(c, row);
    });
  }

  @Post('lis/results')
  @Internal()
  @HttpCode(200)
  lisResults(@Param('tenantId') t: string, @Body() body: unknown) {
    const v = parse(LisResults, body);
    return this.run(t, () => this.results.enterFromLis(v.orderNo, v.source, v.results));
  }
}
