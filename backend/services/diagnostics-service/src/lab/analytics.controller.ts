import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { Internal, notFound, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';

const uuid = (v: string) => { if (!z.uuid().safeParse(v).success) throw notFound('tenant'); return v; };
const Page = z.object({ after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(2000).default(1000) });
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** analytics-service (Phase 29) backfill: lab orders with their milestones (ids and counts only, no test values). */
@Controller('internal/tenants/:tenantId/analytics')
export class InternalAnalyticsController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get('lab-orders')
  @Internal()
  async orders(@Param('tenantId') t: string, @Query() q: unknown) {
    const p = Page.parse(q);
    return TenantContext.run(await this.placements.get(uuid(t)), async () => {
      const { rows } = await this.db.query(
        `SELECT o.id, o.patient_id, o.branch_id, o.status, o.total, o.collection_type, o.created_at, o.updated_at, o.collected_at, o.tat_breached_at,
                (SELECT count(*)::int FROM lab_order_items i WHERE i.order_id = o.id) tests,
                (SELECT min(s.received_at) FROM samples s WHERE s.order_id = o.id) in_lab_at,
                (SELECT min(r.verified_at) FROM lab_reports r WHERE r.order_id = o.id) published_at,
                (SELECT r.abnormal_count FROM lab_reports r WHERE r.order_id = o.id AND r.superseded_by IS NULL ORDER BY r.version DESC LIMIT 1) abnormal,
                (SELECT r.critical_count FROM lab_reports r WHERE r.order_id = o.id AND r.superseded_by IS NULL ORDER BY r.version DESC LIMIT 1) critical
         FROM lab_orders o WHERE ($1::uuid IS NULL OR o.id > $1) ORDER BY o.id LIMIT $2`, [p.after ?? null, p.limit]);
      return rows.map((r) => ({
        id: r.id, patientId: r.patient_id, branchId: r.branch_id, status: r.status, total: Number(r.total), collectionType: r.collection_type, testCount: r.tests,
        orderedAt: iso(r.created_at), updatedAt: iso(r.updated_at), collectedAt: iso(r.collected_at), inLabAt: iso(r.in_lab_at), publishedAt: iso(r.published_at),
        tatBreached: r.tat_breached_at != null, abnormalCount: r.abnormal ?? 0, criticalCount: r.critical ?? 0,
      }));
    });
  }
}
