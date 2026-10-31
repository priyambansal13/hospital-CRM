import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentActor, forbidden, Idempotent, Internal, notFound, parse, PLACEMENTS, TenantPublic } from '@mc/nest-common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { AppointmentsService, LIVE, POLICY, toAppointment } from './appointments.service.js';
import { ScheduleService } from './schedule.service.js';
import { MembershipRules, membersOnly } from './membership.js';

const Uuid = z.uuid();
const id = (v: string, what: string) => { if (!Uuid.safeParse(v).success) throw notFound(what); return v; };
export const Book = z.object({ slotId: z.uuid(), patientId: z.uuid(), reason: z.string().trim().max(500).nullable().default(null), paymentMode: z.enum(['ONLINE', 'AT_CLINIC']).default('AT_CLINIC') });
const Cancel = z.object({ reason: z.string().trim().max(300).nullable().default(null) });
const Reschedule = z.object({ newSlotId: z.uuid() });
const Join = z.object({ doctorId: z.uuid(), date: z.iso.date(), patientId: z.uuid() });
const Days = z.coerce.number().int().min(1).max(60).default(14);

@Controller('v1')
@RequireModule('appointments')
export class AppointmentsController {
  constructor(private readonly db: TenantDbRouter, private readonly svc: AppointmentsService, private readonly schedule: ScheduleService, private readonly membership: MembershipRules) {}

  /** the share of times held for members (0 when the hospital has no memberships) */
  private async heldPct() {
    const t = TenantContext.require();
    return (await this.membership.moduleOn(t.id)) ? this.membership.priorityPct(t.id) : 0;
  }

  /** Bookable times for a published doctor, grouped by local date (public: patients browse before signing in). */
  @Get('public/doctors/:doctorId/slots')
  @TenantPublic()
  async publicSlots(@Param('doctorId') doctorId: string, @Query('days') days: string) {
    const n = parse(Days, days);
    const { rows: d } = await this.db.query(`SELECT id, name, branch_fees FROM doctors WHERE id = $1 AND status = 'ACTIVE'`, [id(doctorId, 'doctor')]);
    if (!d[0]) throw notFound('doctor');
    const { rows } = await this.db.query(
      `SELECT s.id, s.starts_at, s.mode, s.branch_id, b.name branch_name,
              to_char(s.starts_at AT TIME ZONE b.timezone, 'YYYY-MM-DD') local_date, to_char(s.starts_at AT TIME ZONE b.timezone, 'HH24:MI') local_time
       FROM slots s JOIN branches b ON b.id = s.branch_id
       WHERE s.doctor_id = $1 AND s.status = 'OPEN' AND s.starts_at > now() + make_interval(mins => $2) AND s.starts_at < now() + make_interval(days => $3)
         AND (s.mode = 'IN_PERSON' OR $4)
       ORDER BY s.starts_at`,
      [doctorId, POLICY.minLeadMinutes, n, POLICY.videoEnabled],
    );
    const fees = new Map((d[0].branch_fees as { branchId: string; fee: number }[]).map((f) => [f.branchId, f.fee]));
    const pct = await this.heldPct();
    const byDate = new Map<string, { date: string; slots: unknown[] }>();
    for (const r of rows) {
      if (!byDate.has(r.local_date)) byDate.set(r.local_date, { date: r.local_date, slots: [] });
      byDate.get(r.local_date)!.slots.push({ slotId: r.id, startsAt: r.starts_at, localTime: r.local_time, mode: r.mode, branch: { id: r.branch_id, name: r.branch_name }, fee: fees.get(r.branch_id) ?? null, membersOnly: membersOnly(r.id, r.starts_at, pct) });
    }
    return { doctor: { id: d[0].id, name: d[0].name }, days: [...byDate.values()] };
  }

  /** One slot (confirmation page). */
  @Get('public/slots/:slotId')
  @TenantPublic()
  async publicSlot(@Param('slotId') slotId: string) {
    const { rows } = await this.db.query(
      `SELECT s.id, s.status, s.starts_at, s.mode, s.doctor_id, d.name doctor_name, d.branch_fees, s.branch_id, b.name branch_name,
              to_char(s.starts_at AT TIME ZONE b.timezone, 'YYYY-MM-DD') local_date, to_char(s.starts_at AT TIME ZONE b.timezone, 'HH24:MI') local_time
       FROM slots s JOIN doctors d ON d.id = s.doctor_id JOIN branches b ON b.id = s.branch_id WHERE s.id = $1 AND d.status = 'ACTIVE'`, [id(slotId, 'slot')]);
    const r = rows[0];
    if (!r) throw notFound('slot');
    const fee = (r.branch_fees as { branchId: string; fee: number }[]).find((f) => f.branchId === r.branch_id)?.fee ?? null;
    return { slotId: r.id, available: r.status === 'OPEN' && new Date(r.starts_at).getTime() > Date.now() + POLICY.minLeadMinutes * 60_000, startsAt: r.starts_at, localDate: r.local_date, localTime: r.local_time, mode: r.mode, doctor: { id: r.doctor_id, name: r.doctor_name }, branch: { id: r.branch_id, name: r.branch_name }, fee, membersOnly: membersOnly(r.id, r.starts_at, await this.heldPct()) };
  }

  @Post('appointments')
  @Idempotent()
  @RequirePermission('appointment:create:own')
  book(@Body() body: unknown, @CurrentActor() actor: Actor, @Headers('x-mc-via') via?: string) {
    // a label only (the patient's own token still books it): which bookings came from the AI assistant
    return this.svc.book(actor, parse(Book, body), via === 'ASSISTANT' ? 'ASSISTANT' : null);
  }

  @Get('me/appointments')
  @RequirePermission('appointment:read:own')
  async mine(@CurrentActor() actor: Actor) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'patients only');
    const { rows } = await this.db.query(
      `SELECT a.*, d.name AS doctor_name, b.name AS branch_name, b.timezone,
              to_char(a.starts_at AT TIME ZONE b.timezone, 'YYYY-MM-DD') local_date, to_char(a.starts_at AT TIME ZONE b.timezone, 'HH24:MI') local_time
       FROM appointments a JOIN doctors d ON d.id = a.doctor_id JOIN branches b ON b.id = a.branch_id
       WHERE a.account_person_id = $1 AND a.status <> 'RESCHEDULED' ORDER BY a.starts_at DESC LIMIT 200`, [actor.id]);
    const all = rows.map(toAppointment);
    const now = Date.now();
    const live = ['CONFIRMED', 'PENDING_PAYMENT', 'CHECKED_IN', 'IN_PROGRESS'];
    return {
      upcoming: all.filter((a) => live.includes(a.status) && new Date(a.endsAt).getTime() > now).reverse(),
      past: all.filter((a) => !(live.includes(a.status) && new Date(a.endsAt).getTime() > now)),
      // the hospital's setting, not the default: the buttons must match what is enforced (review F-3)
      policy: { cancelWindowHours: await this.svc.cutoffHours(), maxReschedules: POLICY.maxReschedules },
    };
  }

  @Get('appointments/:id')
  async get(@Param('id') apptId: string, @CurrentActor() actor: Actor) {
    const { row } = await this.svc.assertAccess(await this.db.current(), actor, id(apptId, 'appointment'), 'appointment:read:branch');
    return toAppointment(row);
  }

  @Post('appointments/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') apptId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.cancel(actor, id(apptId, 'appointment'), parse(Cancel, body ?? {}).reason);
  }

  @Post('appointments/:id/reschedule')
  @HttpCode(200)
  reschedule(@Param('id') apptId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.reschedule(actor, id(apptId, 'appointment'), parse(Reschedule, body).newSlotId);
  }

  @Post('waitlist')
  @RequirePermission('appointment:create:own')
  join(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.joinWaitlist(actor, parse(Join, body));
  }

  @Get('me/waitlist')
  @RequirePermission('appointment:read:own')
  async myWaitlist(@CurrentActor() actor: Actor) {
    const { rows } = await this.db.query(
      `SELECT w.id, w.patient_id, w.patient_name, w.doctor_id, d.name doctor_name, to_char(w.date, 'YYYY-MM-DD') date, w.notified_at
       FROM waitlist w JOIN doctors d ON d.id = w.doctor_id WHERE w.account_person_id = $1 AND w.date >= current_date ORDER BY w.date`, [actor.id]);
    return rows.map((r) => ({ id: r.id, patient: { id: r.patient_id, name: r.patient_name }, doctor: { id: r.doctor_id, name: r.doctor_name }, date: r.date, notifiedAt: r.notified_at }));
  }

  @Delete('waitlist/:id')
  @RequirePermission('appointment:create:own')
  @HttpCode(204)
  async leave(@Param('id') wid: string, @CurrentActor() actor: Actor) {
    const { rowCount } = await this.db.query('DELETE FROM waitlist WHERE id = $1 AND account_person_id = $2', [id(wid, 'waitlist entry'), actor.id]);
    if (!rowCount) throw notFound('waitlist entry');
  }

  /** A doctor's appointments (doctor zone / admin). */
  @Get('doctors/:doctorId/appointments')
  async doctorAppointments(@Param('doctorId') doctorId: string, @Query('from') from: string | undefined, @Query('days') days: string, @CurrentActor() actor: Actor) {
    const pool = await this.db.current();
    const d = await this.schedule.assertCanManage(pool, actor, id(doctorId, 'doctor'));
    const start = parse(z.iso.date().optional(), from) ?? new Date().toISOString().slice(0, 10);
    const n = parse(Days, days);
    const { rows } = await pool.query(
      `SELECT a.*, d.name AS doctor_name, b.name AS branch_name, b.timezone,
              to_char(a.starts_at AT TIME ZONE b.timezone, 'YYYY-MM-DD') local_date, to_char(a.starts_at AT TIME ZONE b.timezone, 'HH24:MI') local_time
       FROM appointments a JOIN doctors d ON d.id = a.doctor_id JOIN branches b ON b.id = a.branch_id
       WHERE a.doctor_id = $1 AND a.status IN ${LIVE} AND (a.starts_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $2::date + $3::int
       ORDER BY a.starts_at`, [d.id, start, n]);
    return rows.map(toAppointment);
  }
}

/** Service-to-service: is this appointment still on? (notification-service checks before sending a reminder) */
@Controller('internal/tenants/:tenantId/appointments')
export class InternalAppointmentsController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get(':id/status')
  @Internal()
  async status(@Param('tenantId') tenantId: string, @Param('id') apptId: string) {
    id(tenantId, 'tenant');
    return TenantContext.run(await this.placements.get(tenantId), async () => {
      const { rows } = await this.db.query('SELECT status, starts_at FROM appointments WHERE id = $1', [id(apptId, 'appointment')]);
      if (!rows[0]) throw notFound('appointment');
      return { status: rows[0].status, startsAt: rows[0].starts_at };
    });
  }
}

/** search-service: each doctor's next bookable time (one query for the whole hospital, or one doctor). */
@Controller('internal/tenants/:tenantId/next-slots')
export class InternalNextSlotsController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get()
  @Internal()
  async nextSlots(@Param('tenantId') tenantId: string, @Query('doctorId') doctorId?: string) {
    id(tenantId, 'tenant');
    if (doctorId) id(doctorId, 'doctor');
    return TenantContext.run(await this.placements.get(tenantId), async () => {
      const { rows } = await this.db.query(
        `SELECT DISTINCT ON (doctor_id) doctor_id, starts_at, mode FROM slots
         WHERE status = 'OPEN' AND starts_at > now() + make_interval(mins => $2) AND ($1::uuid IS NULL OR doctor_id = $1) AND (mode = 'IN_PERSON' OR $3)
         ORDER BY doctor_id, starts_at`, [doctorId ?? null, POLICY.minLeadMinutes, POLICY.videoEnabled]);
      return { next: Object.fromEntries(rows.map((r) => [r.doctor_id, r.starts_at])) };
    });
  }
}
