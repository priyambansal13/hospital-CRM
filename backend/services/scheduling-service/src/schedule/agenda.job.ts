import { Body, Controller, HttpCode, Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown, Param, Post } from '@nestjs/common';
import { type DoctorAgenda, EventTypes, Topics } from '@mc/contracts';
import { Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { addToOutbox, envelope, type PlacementSource, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;
/** local hour (at the branch) from which the day's agenda goes out */
export const AGENDA_HOUR = Number(process.env.AGENDA_HOUR ?? 7);

/**
 * Each doctor's list for the day, e-mailed once in the morning (docs/ROLE-FLOWS-AND-GAPS.md 4.G): who is booked, when,
 * where. Doctors with nothing booked get nothing. Every 10 minutes, per hospital; `agenda_sent` makes it once a day.
 */
@Injectable()
export class AgendaJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('AgendaJob');
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly entitlements: EntitlementsClient) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => this.runOnce().catch((e) => this.log.warn(`agenda failed: ${(e as Error).message}`)), Number(process.env.AGENDA_INTERVAL_MS ?? 600_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async runOnce() {
    const n = Number(process.env.REPLICA_COUNT ?? 1);
    const i = Number(process.env.REPLICA_INDEX ?? 0);
    let sent = 0;
    for (const t of await this.placements.list()) {
      if (t.status !== 'ACTIVE' || shardOf(t.id, n) !== i) continue;
      if ((await this.entitlements.moduleState(t.id, 'appointments').catch(() => 'OFF')) !== 'ACTIVE') continue;
      sent += await TenantContext.run(t, () => this.db.tx((c) => sendAgendas(c, AGENDA_HOUR))).catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
    }
    if (sent) this.log.log(`${sent} agenda(s) sent`);
    return sent;
  }
}

/** Doctors whose local day has reached `hour` and who have bookings today and no agenda yet: one event each. */
export async function sendAgendas(c: Queryable, hour: number) {
  const { rows } = await c.query(
    `SELECT a.doctor_id, d.user_id, d.name AS doctor_name, to_char(a.local_date, 'YYYY-MM-DD') AS day,
            json_agg(json_build_object('time', to_char(a.starts_at AT TIME ZONE b.timezone, 'HH24:MI'), 'patientName', a.patient_name,
              'appointmentNo', a.appointment_no, 'branchName', b.name, 'mode', a.mode) ORDER BY a.starts_at) AS items
     FROM appointments a JOIN doctors d ON d.id = a.doctor_id JOIN branches b ON b.id = a.branch_id
     WHERE d.user_id IS NOT NULL AND a.status IN ('CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED') AND a.local_date = (now() AT TIME ZONE b.timezone)::date
       AND extract(hour FROM now() AT TIME ZONE b.timezone) >= $1
       AND NOT EXISTS (SELECT 1 FROM agenda_sent s WHERE s.doctor_id = a.doctor_id AND s.day = a.local_date)
     GROUP BY a.doctor_id, d.user_id, d.name, a.local_date`, [hour]);
  for (const r of rows) {
    const { rowCount } = await c.query('INSERT INTO agenda_sent (doctor_id, day) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.doctor_id, r.day]);
    if (!rowCount) continue;
    const data: DoctorAgenda = { doctorId: r.doctor_id, doctorUserId: r.user_id, doctorName: r.doctor_name, date: r.day, items: r.items };
    await addToOutbox(c, Topics.scheduling, r.doctor_id, envelope(EventTypes.doctorAgenda, data, { tenantId: TenantContext.require().id, subject: `${r.doctor_id}:${r.day}` }));
  }
  return rows.length;
}

/** Ops/tests: send the day's agendas for one hospital now (`hour` 0 = whatever the time). */
@Controller('internal/tenants/:tenantId/agenda')
export class InternalAgendaController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post()
  @Internal()
  @HttpCode(200)
  async send(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    const { hour } = parse(z.object({ hour: z.number().int().min(0).max(23).default(AGENDA_HOUR) }), body ?? {});
    return TenantContext.run(await this.placements.get(tenantId), async () => ({ sent: await this.db.tx((c) => sendAgendas(c, hour)) }));
  }
}
