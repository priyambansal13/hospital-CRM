import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { Internal, notFound, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';

const uuid = (v: string) => { if (!z.uuid().safeParse(v).success) throw notFound('tenant'); return v; };
const Page = z.object({ after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(2000).default(1000) });
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** analytics-service (Phase 29) backfill: registrations (id, date, date of birth and gender for age bands; no names). */
@Controller('internal/tenants/:tenantId/analytics')
export class InternalAnalyticsController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get('patients')
  @Internal()
  async patients(@Param('tenantId') t: string, @Query() q: unknown) {
    const p = Page.parse(q);
    return TenantContext.run(await this.placements.get(uuid(t)), async () => {
      const { rows } = await this.db.query(`SELECT id, created_at, to_char(dob, 'YYYY-MM-DD') dob, gender FROM patients WHERE ($1::uuid IS NULL OR id > $1) ORDER BY id LIMIT $2`, [p.after ?? null, p.limit]);
      return rows.map((r) => ({ patientId: r.id, registeredAt: iso(r.created_at), dob: r.dob, gender: r.gender }));
    });
  }
}
