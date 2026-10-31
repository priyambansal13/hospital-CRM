import { Controller, Get } from '@nestjs/common';
import { branchFilter, EntitlementsClient, RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { CurrentActor } from '@mc/nest-common';
import { type Actor, TenantContext, TenantDbRouter } from '@mc/tenancy';

const PERMISSION = 'schedule:manage:branch';

/**
 * Numbers for the admin dashboard: today's appointments by state, the next 7 days, how people booked, the busiest
 * doctors. Only the branches the person manages; dates are each branch's own calendar day.
 */
@Controller('v1/stats')
@RequireModule('appointments')
export class StatsController {
  constructor(private readonly db: TenantDbRouter, private readonly entitlements: EntitlementsClient) {}

  @Get('overview')
  @RequirePermission(PERMISSION)
  async overview(@CurrentActor() actor: Actor) {
    const caps = await this.entitlements.capabilities(TenantContext.require().id, actor);
    const scope = branchFilter(caps, PERMISSION, 'a.branch_id', 1);
    const local = `(a.starts_at AT TIME ZONE b.timezone)::date`;
    const today = `(now() AT TIME ZONE b.timezone)::date`;
    const [{ rows: states }, { rows: days }, { rows: sources }, { rows: doctors }] = await Promise.all([
      this.db.query(`SELECT a.status, count(*)::int n FROM appointments a JOIN branches b ON b.id = a.branch_id WHERE ${local} = ${today}${scope.sql} GROUP BY a.status`, scope.args),
      this.db.query(`SELECT to_char(${local}, 'YYYY-MM-DD') d, count(*)::int n FROM appointments a JOIN branches b ON b.id = a.branch_id
        WHERE ${local} BETWEEN ${today} AND ${today} + 6 AND a.status NOT IN ('CANCELLED','EXPIRED','RESCHEDULED')${scope.sql} GROUP BY 1 ORDER BY 1`, scope.args),
      this.db.query(`SELECT CASE WHEN a.booked_via = 'ASSISTANT' THEN 'ASSISTANT' ELSE a.source END s, count(*)::int n FROM appointments a JOIN branches b ON b.id = a.branch_id
        WHERE a.created_at > now() - interval '30 days' AND a.status <> 'RESCHEDULED'${scope.sql} GROUP BY 1`, scope.args),
      this.db.query(`SELECT d.name, count(*)::int n FROM appointments a JOIN branches b ON b.id = a.branch_id JOIN doctors d ON d.id = a.doctor_id
        WHERE ${local} BETWEEN ${today} AND ${today} + 6 AND a.status NOT IN ('CANCELLED','EXPIRED','RESCHEDULED')${scope.sql} GROUP BY d.name ORDER BY n DESC, d.name LIMIT 5`, scope.args),
    ]);
    const by = Object.fromEntries(states.map((r) => [r.status, r.n]));
    const start = new Date();
    const next7 = Array.from({ length: 7 }, (_, i) => {
      const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(start.getTime() + i * 86_400_000));
      return { date: d, count: days.find((x) => x.d === d)?.n ?? 0 };
    });
    return {
      today: {
        booked: Object.entries(by).filter(([s]) => !['CANCELLED', 'EXPIRED', 'RESCHEDULED'].includes(s)).reduce((n, [, v]) => n + (v as number), 0),
        waiting: by.CHECKED_IN ?? 0, inProgress: by.IN_PROGRESS ?? 0, completed: by.COMPLETED ?? 0, noShow: by.NO_SHOW ?? 0, cancelled: by.CANCELLED ?? 0,
      },
      next7,
      sources: Object.fromEntries(sources.map((r) => [r.s, r.n])),
      busiestDoctors: doctors.map((r) => ({ name: r.name, count: r.n })),
    };
  }
}
