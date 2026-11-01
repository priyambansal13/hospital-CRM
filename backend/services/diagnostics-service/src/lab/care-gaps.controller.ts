import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';

const Ask = z.object({ patientIds: z.array(z.uuid()).max(5000), testCodes: z.array(z.string().regex(/^[A-Z0-9_]{2,30}$/)).min(1).max(10) });

/**
 * ai-assistant-service (Phase 29, care gaps): when each patient last had one of these tests, counting a published
 * report or an order still on its way (booked, collected, in the lab), so nobody is reminded of a test already booked.
 */
@Controller('internal/tenants/:tenantId/care-gaps')
export class InternalCareGapsController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post('last-tests')
  @Internal()
  @HttpCode(200)
  async lastTests(@Param('tenantId') t: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(t).success) throw notFound('tenant');
    const a = parse(Ask, body);
    return TenantContext.run(await this.placements.get(t), async () => {
      const { rows } = await this.db.query(
        `SELECT o.patient_id, max(coalesce((SELECT min(r.verified_at) FROM lab_reports r WHERE r.order_id = o.id), o.created_at)) last_at
         FROM lab_orders o JOIN lab_order_items i ON i.order_id = o.id
         WHERE o.patient_id = ANY($1) AND i.test_code = ANY($2) AND o.status NOT IN ('CANCELLED','EXPIRED','AWAITING_BOOKING')
         GROUP BY o.patient_id`, [a.patientIds, a.testCodes]);
      return rows.map((r) => ({ patientId: r.patient_id, lastAt: r.last_at }));
    });
  }
}
