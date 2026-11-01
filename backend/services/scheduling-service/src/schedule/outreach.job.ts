import { Body, Controller, HttpCode, Inject, Injectable, Logger, Param, Post, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EventTypes } from '@mc/contracts';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { AppointmentsService } from './appointments.service.js';

export const OUTREACH_HOUR = Number(process.env.NOSHOW_OUTREACH_HOUR ?? 17);
export const RISK_THRESHOLD = Number(process.env.NOSHOW_RISK_THRESHOLD ?? 3);

export interface RiskInput { priorNoShows: number; priorVisits: number; leadDays: number; paid: boolean; source: string }

/**
 * No-show risk (docs/AI-AGENTS.md §7): a transparent points score, not a model. Past no-shows weigh most; a first
 * visit, a booking made long ahead and nothing paid add a point each; paying ahead takes one off. Score ≥ the
 * threshold (3) gets the evening-before "please confirm" message.
 */
export function noShowRisk(r: RiskInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (r.priorNoShows >= 2) { score += 3; reasons.push(`${r.priorNoShows} earlier no-shows`); }
  else if (r.priorNoShows === 1) { score += 2; reasons.push('1 earlier no-show'); }
  if (r.priorVisits === 0) { score += 1; reasons.push('first visit'); }
  if (r.leadDays >= 14) { score += 1; reasons.push(`booked ${r.leadDays} days ahead`); }
  if (!r.paid) { score += 1; reasons.push('not paid ahead'); } else score -= 1;
  return { score: Math.max(0, score), reasons };
}

/** Tomorrow's bookings (each branch's own tomorrow) from `hour` local time, each scored once (noshow_risk); returns the number messaged. */
export async function sendOutreach(c: Queryable, appts: AppointmentsService, hour: number, threshold = RISK_THRESHOLD) {
  const { rows } = await c.query(
    `SELECT a.id, a.source, a.payment_status, (a.local_date - (a.created_at AT TIME ZONE b.timezone)::date) lead_days,
            (SELECT count(*)::int FROM appointments p WHERE p.patient_id = a.patient_id AND p.status = 'NO_SHOW' AND p.starts_at < a.starts_at) no_shows,
            (SELECT count(*)::int FROM appointments p WHERE p.patient_id = a.patient_id AND p.status = 'COMPLETED' AND p.starts_at < a.starts_at) visits
     FROM appointments a JOIN branches b ON b.id = a.branch_id
     WHERE a.status = 'CONFIRMED' AND a.source IN ('ONLINE','DESK') AND a.noshow_risk IS NULL AND a.attendance_confirmed_at IS NULL
       AND a.local_date = (now() AT TIME ZONE b.timezone)::date + 1 AND extract(hour FROM now() AT TIME ZONE b.timezone) >= $1
     ORDER BY a.starts_at LIMIT 2000`, [hour]);
  let sent = 0;
  for (const r of rows) {
    const risk = noShowRisk({ priorNoShows: r.no_shows, priorVisits: r.visits, leadDays: r.lead_days, paid: r.payment_status === 'PAID', source: r.source });
    const high = risk.score >= threshold;
    await c.query(`UPDATE appointments SET noshow_risk = $2, outreach_sent_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1`, [r.id, risk.score, high]);
    if (!high) continue;
    await appts.emit(c, EventTypes.attendanceCheck, await appts.find(c, r.id));
    sent++;
  }
  return sent;
}

@Injectable()
export class OutreachJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('NoShowOutreach');
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: TenantDbRouter, private readonly appts: AppointmentsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly entitlements: EntitlementsClient) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => void this.runOnce().catch((e) => this.log.warn(`outreach failed: ${(e as Error).message}`)), Number(process.env.NOSHOW_OUTREACH_INTERVAL_MS ?? 900_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async runOnce() {
    let sent = 0;
    for (const t of await this.placements.list()) {
      if (t.status !== 'ACTIVE') continue;
      if ((await this.entitlements.moduleState(t.id, 'ai_ops').catch(() => 'OFF')) !== 'ACTIVE') continue;
      if ((await this.entitlements.tenantFeatures(t.id).catch(() => null))?.features['ai_ops.noshow_outreach']?.enabled === false) continue;
      sent += await TenantContext.run(t, () => this.db.tx((c) => sendOutreach(c, this.appts, OUTREACH_HOUR))).catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
    }
    if (sent) this.log.log(`${sent} attendance check(s) sent`);
    return sent;
  }
}

@Controller('internal/tenants/:tenantId/noshow-outreach')
export class InternalOutreachController {
  constructor(private readonly db: TenantDbRouter, private readonly appts: AppointmentsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post()
  @Internal()
  @HttpCode(200)
  async run(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    const { hour } = parse(z.object({ hour: z.number().int().min(0).max(23).default(OUTREACH_HOUR) }), body ?? {});
    return TenantContext.run(await this.placements.get(tenantId), async () => ({ sent: await this.db.tx((c) => sendOutreach(c, this.appts, hour)) }));
  }
}
