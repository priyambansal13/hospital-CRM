import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { Internal, notFound, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';

const uuid = (v: string) => { if (!z.uuid().safeParse(v).success) throw notFound('tenant'); return v; };
const Page = z.object({ after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(2000).default(1000) });
const Range = z.object({ from: z.iso.date(), to: z.iso.date() });

/**
 * analytics-service (Phase 29): the warehouse's backfill (appointments made before it listened to events), its
 * dimensions, and doctors' bookable time per day (slots are not events). Ids only: no patient names or contact details.
 */
@Controller('internal/tenants/:tenantId/analytics')
export class InternalAnalyticsController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}
  private async run<T>(t: string, fn: () => Promise<T>) { return TenantContext.run(await this.placements.get(uuid(t)), fn); }

  @Get('dimensions')
  @Internal()
  dims(@Param('tenantId') t: string) {
    return this.run(t, async () => {
      const [{ rows: branches }, { rows: doctors }] = await Promise.all([
        this.db.query('SELECT id, name, timezone, active FROM branches'),
        this.db.query('SELECT id, name, status, branch_ids, specialty_codes FROM doctors'),
      ]);
      return {
        branches: branches.map((b) => ({ id: b.id, name: b.name, timezone: b.timezone, active: b.active })),
        doctors: doctors.map((d) => ({ id: d.id, name: d.name, status: d.status, branchIds: d.branch_ids ?? [], specialtyCodes: d.specialty_codes ?? [] })),
      };
    });
  }

  @Get('appointments')
  @Internal()
  appointments(@Param('tenantId') t: string, @Query() q: unknown) {
    const p = Page.parse(q);
    return this.run(t, async () => {
      const { rows } = await this.db.query(
        `SELECT id, patient_id, doctor_id, branch_id, starts_at, to_char(local_date, 'YYYY-MM-DD') local_date, status, mode, source, booked_via, payment_mode, fee, created_at, updated_at, rescheduled_from, campaign
         FROM appointments WHERE ($1::uuid IS NULL OR id > $1) ORDER BY id LIMIT $2`, [p.after ?? null, p.limit]);
      return rows.map((r) => ({
        id: r.id, patientId: r.patient_id, doctorId: r.doctor_id, branchId: r.branch_id, startsAt: new Date(r.starts_at).toISOString(), localDate: r.local_date,
        status: r.status, mode: r.mode, source: r.source, bookedVia: r.booked_via, paymentMode: r.payment_mode, fee: r.fee == null ? null : Number(r.fee),
        bookedAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), rescheduledFrom: r.rescheduled_from, campaign: r.campaign,
      }));
    });
  }

  /** Slots per doctor, branch and local day: all offered (not blocked) and booked. */
  @Get('capacity')
  @Internal()
  capacity(@Param('tenantId') t: string, @Query() q: unknown) {
    const r = Range.parse(q);
    return this.run(t, async () => {
      const { rows } = await this.db.query(
        `SELECT s.doctor_id, s.branch_id, to_char((s.starts_at AT TIME ZONE b.timezone)::date, 'YYYY-MM-DD') d,
                count(*) FILTER (WHERE s.status <> 'BLOCKED')::int slots, count(*) FILTER (WHERE s.status = 'BOOKED')::int booked
         FROM slots s JOIN branches b ON b.id = s.branch_id
         WHERE (s.starts_at AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date GROUP BY 1, 2, 3`, [r.from, r.to]);
      return rows.map((x) => ({ doctorId: x.doctor_id, branchId: x.branch_id, localDate: x.d, slots: x.slots, booked: x.booked }));
    });
  }
}
