import { Injectable } from '@nestjs/common';
import type { TenantPlacement } from '@mc/contracts';
import { notFound } from '@mc/nest-common';
import { TenantContext, TenantDbRouter } from '@mc/tenancy';
import { Backfill } from '../warehouse/backfill.js';

const BOOKED = `status NOT IN ('RESCHEDULED','EXPIRED','PENDING_PAYMENT','CANCELLED')`;

/**
 * The facts behind a branch's morning brief (docs/AI-AGENTS.md §6), all from the warehouse: today's load against the
 * doctors' bookable time, yesterday's visits, no-shows, cancellations and money, lab reports past their promised
 * time, payments that could not be applied. ai-assistant-service writes the brief's wording from these numbers.
 */
@Injectable()
export class BriefFacts {
  constructor(private readonly db: TenantDbRouter, private readonly backfill: Backfill) {}

  async forBranch(t: TenantPlacement, branchId: string) {
    // today's bookable time changes through the night (leave, extra hours): refresh it first
    await this.backfill.refresh(t, new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)).catch(() => undefined);
    return TenantContext.run(t, async () => {
      const { rows: [b] } = await this.db.query(`SELECT id, name, timezone, (now() AT TIME ZONE timezone)::date::text today, ((now() AT TIME ZONE timezone)::date - 1)::text yesterday FROM dim_branches WHERE id = $1`, [branchId]);
      if (!b) throw notFound('branch');
      const args = [branchId, b.today, b.yesterday];
      const [today, cap, doctors, yday, money, lab, issues] = await Promise.all([
        this.db.query(`SELECT count(*) FILTER (WHERE ${BOOKED})::int booked, count(*) FILTER (WHERE ${BOOKED} AND source = 'WALK_IN')::int walk_ins FROM fact_appointments WHERE branch_id = $1 AND local_date = $2::date`, args.slice(0, 2)),
        this.db.query(`SELECT coalesce(sum(slots), 0)::int slots, coalesce(sum(booked), 0)::int booked, count(*) FILTER (WHERE slots > 0)::int doctors FROM fact_capacity WHERE branch_id = $1 AND local_date = $2::date`, args.slice(0, 2)),
        this.db.query(`SELECT d.name, c.slots, c.booked FROM fact_capacity c JOIN dim_doctors d ON d.id = c.doctor_id WHERE c.branch_id = $1 AND c.local_date = $2::date AND c.slots > 0 ORDER BY c.booked::float / c.slots DESC, d.name LIMIT 20`, args.slice(0, 2)),
        this.db.query(`SELECT count(*) FILTER (WHERE status = 'COMPLETED')::int completed, count(*) FILTER (WHERE status = 'NO_SHOW')::int no_shows,
                              count(*) FILTER (WHERE status = 'CANCELLED')::int cancelled, count(*) FILTER (WHERE status IN ('COMPLETED','NO_SHOW','CHECKED_IN','IN_PROGRESS'))::int due
                       FROM fact_appointments WHERE branch_id = $1 AND local_date = $3::date`, args),
        this.db.query(`SELECT coalesce(sum(amount) FILTER (WHERE kind = 'PAYMENT'), 0) collected, coalesce(-sum(amount) FILTER (WHERE kind = 'REFUND'), 0) refunded FROM fact_payments WHERE branch_id = $1 AND local_date = $3::date`, args),
        this.db.query(`SELECT count(*) FILTER (WHERE tat_breached AND published_at IS NULL AND status NOT IN ('CANCELLED','EXPIRED'))::int late,
                              count(*) FILTER (WHERE in_lab_at IS NOT NULL AND published_at IS NULL AND status NOT IN ('CANCELLED','EXPIRED'))::int in_lab
                       FROM fact_lab_orders WHERE branch_id = $1`, args.slice(0, 1)),
        this.db.query(`SELECT count(*)::int n FROM fact_payment_issues WHERE branch_id = $1 AND (at AT TIME ZONE 'Asia/Kolkata')::date >= $3::date`, args),
      ]);
      const y = yday.rows[0];
      return {
        branchId, branchName: b.name as string, date: b.today as string, yesterday: b.yesterday as string,
        today: {
          booked: today.rows[0].booked as number, walkIns: today.rows[0].walk_ins as number, slots: cap.rows[0].slots as number, slotsBooked: cap.rows[0].booked as number,
          loadPercent: cap.rows[0].slots ? Math.round((100 * cap.rows[0].booked) / cap.rows[0].slots) : null, doctorsWorking: cap.rows[0].doctors as number,
          fullest: doctors.rows.slice(0, 3).map((d) => ({ name: d.name as string, booked: d.booked as number, slots: d.slots as number })),
          mostFree: [...doctors.rows].reverse().slice(0, 3).filter((d) => d.slots - d.booked > 0).map((d) => ({ name: d.name as string, free: (d.slots - d.booked) as number })),
        },
        yesterdayStats: {
          completed: y.completed as number, noShows: y.no_shows as number, cancelled: y.cancelled as number,
          noShowRate: y.due ? Math.round((1000 * y.no_shows) / y.due) / 10 : null,
          collected: Number(money.rows[0].collected), refunded: Number(money.rows[0].refunded),
        },
        lab: { late: lab.rows[0].late as number, inLab: lab.rows[0].in_lab as number },
        paymentIssues: issues.rows[0].n as number,
      };
    });
  }
}
