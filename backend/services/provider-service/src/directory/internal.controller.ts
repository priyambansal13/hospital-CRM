import { Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { Internal, notFound, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { DoctorsController } from './doctors.controller.js';

/** Operations endpoints (service-to-service / platform CLI only). */
@Controller('internal/tenants/:tenantId')
export class InternalProviderController {
  constructor(private readonly doctors: DoctorsController, private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post('doctors/republish')
  @Internal()
  async republish(@Param('tenantId') tenantId: string) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    return TenantContext.run(await this.placements.get(tenantId), () => this.doctors.republishAll(tenantId));
  }

  /** Specialty names (analytics-service, Phase 29: report labels). */
  @Get('specialties')
  @Internal()
  async specialties(@Param('tenantId') tenantId: string) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    return TenantContext.run(await this.placements.get(tenantId), async () => (await this.db.query('SELECT code, name FROM specialties ORDER BY code')).rows.map((r) => ({ code: r.code, name: r.name })));
  }

  /** Active doctors (not INACTIVE): per-seat pricing on MediCare's invoice (subscription-service). */
  @Get('doctor-count')
  @Internal()
  async doctorCount(@Param('tenantId') tenantId: string) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    return TenantContext.run(await this.placements.get(tenantId), async () => ({ doctors: Number((await this.db.query(`SELECT count(*) n FROM doctors WHERE status <> 'INACTIVE'`)).rows[0].n) }));
  }
}
