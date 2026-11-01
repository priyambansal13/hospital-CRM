import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { Internal, notFound, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';

const uuid = (v: string) => { if (!z.uuid().safeParse(v).success) throw notFound('tenant'); return v; };
const Page = z.object({ after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(2000).default(1000) });
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/**
 * analytics-service (Phase 29) backfill: money that moved, as the events report it: captured payments that paid an
 * invoice and processed refunds (a duplicate payment and its automatic refund are left out, as they have no event).
 */
@Controller('internal/tenants/:tenantId/analytics')
export class InternalAnalyticsController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get('payments')
  @Internal()
  async payments(@Param('tenantId') t: string, @Query() q: unknown) {
    const p = Page.parse(q);
    return TenantContext.run(await this.placements.get(uuid(t)), async () => {
      const { rows } = await this.db.query(
        `SELECT * FROM (
           SELECT p.id, 'PAYMENT' kind, p.invoice_id, i.source_type, i.source_id, i.branch_id, p.amount, p.channel, p.method, coalesce(p.captured_at, p.created_at) at
           FROM payments p JOIN invoices i ON i.id = p.invoice_id
           WHERE p.status = 'CAPTURED' AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.dedupe_key LIKE 'duplicate:%')
           UNION ALL
           SELECT r.id, 'REFUND', r.invoice_id, i.source_type, i.source_id, i.branch_id, r.amount, NULL, NULL, coalesce(r.processed_at, r.created_at)
           FROM refunds r JOIN invoices i ON i.id = r.invoice_id
           WHERE r.status = 'PROCESSED' AND coalesce(r.dedupe_key, '') NOT LIKE 'duplicate:%'
         ) x WHERE ($1::uuid IS NULL OR x.id > $1) ORDER BY x.id LIMIT $2`, [p.after ?? null, p.limit]);
      return rows.map((r) => ({
        id: r.id, kind: r.kind, invoiceId: r.invoice_id, sourceType: r.source_type, sourceId: r.source_id, branchId: r.branch_id,
        amount: Number(r.amount), channel: r.channel, method: r.method, at: iso(r.at),
      }));
    });
  }
}
