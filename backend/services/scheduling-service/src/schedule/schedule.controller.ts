import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentActor, DomainError, notFound, parse } from '@mc/nest-common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { AppointmentsService, POLICY } from './appointments.service.js';
import { LOCAL_DATE } from './slots.sql.js';
import { HORIZON_DAYS, ScheduleService } from './schedule.service.js';

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const DateStr = z.iso.date();
export const SLOT_MINUTES = [5, 10, 15, 20, 30, 45, 60];
const today = () => new Date().toISOString().slice(0, 10);

export const AddHours = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).transform((d) => [...new Set(d)].sort()),
  branchId: z.uuid(),
  startTime: Time,
  endTime: Time,
  slotMinutes: z.number().int().refine((n) => SLOT_MINUTES.includes(n), { message: `one of ${[5, 10, 15, 20, 30, 45, 60].join(', ')}` }),
  mode: z.enum(['IN_PERSON', 'VIDEO']).default('IN_PERSON'),
  effectiveFrom: DateStr.optional(),
  effectiveTo: DateStr.nullable().default(null),
}).refine((h) => h.endTime > h.startTime, { message: 'end time must be after start time', path: ['endTime'] });

export const AddLeave = z.object({
  fromDate: DateStr,
  toDate: DateStr,
  reason: z.string().trim().max(200).nullable().default(null),
}).refine((l) => l.toDate >= l.fromDate, { message: 'end date must be on or after start date', path: ['toDate'] });

const Uuid = z.uuid();
const id = (v: string, what: string) => { if (!Uuid.safeParse(v).success) throw notFound(what); return v; };

/** Weekly hours, leave and slots. A doctor manages their own; admins manage anyone's (schedule:manage:branch). */
/** Admins see what a change would cancel before unpublishing a doctor or closing a branch (review D-5). */
@Controller('v1/upcoming-appointments')
@RequireModule('appointments')
export class UpcomingAppointmentsController {
  constructor(private readonly appts: AppointmentsService) {}

  @Get()
  @RequirePermission('schedule:manage:branch')
  count(@Query('doctorId') doctorId?: string, @Query('branchId') branchId?: string) {
    const ok = (v?: string) => v === undefined || z.uuid().safeParse(v).success;
    if (!ok(doctorId) || !ok(branchId) || (!doctorId && !branchId)) throw new DomainError(400, 'BAD_QUERY', 'give doctorId or branchId');
    return this.appts.upcomingCount({ doctorId, branchId });
  }
}

@Controller('v1')
@RequireModule('appointments')
export class ScheduleController {
  constructor(private readonly db: TenantDbRouter, private readonly svc: ScheduleService) {}

  /** The signed-in staff member's doctor profile (doctor zone). */
  @Get('me/doctor')
  async me(@CurrentActor() actor: Actor) {
    const { rows } = await this.db.query('SELECT id, name, status FROM doctors WHERE user_id = $1', [actor.id]);
    if (!rows[0]) throw notFound('doctor profile');
    return rows[0];
  }

  @Get('doctors')
  @RequirePermission('schedule:manage:branch')
  async doctors(@CurrentActor() actor: Actor) {
    const scope = await this.svc.manageableBranches(actor);
    const { rows } = await this.db.query(`SELECT d.id, d.name, d.status,
        (SELECT count(*)::int FROM availability_templates t WHERE t.doctor_id = d.id) AS hours,
        (SELECT count(*)::int FROM slots s WHERE s.doctor_id = d.id AND s.status = 'OPEN' AND s.starts_at > now() AND s.starts_at < now() + interval '7 days') AS open_next_7_days
      FROM doctors d WHERE $1::uuid[] IS NULL OR d.branch_ids && $1 ORDER BY d.name`, [scope]);
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, hours: r.hours, openNext7Days: r.open_next_7_days }));
  }

  @Get('doctors/:doctorId/schedule')
  async schedule(@Param('doctorId') doctorId: string, @CurrentActor() actor: Actor) {
    const pool = await this.db.current();
    const d = await this.svc.assertCanManage(pool, actor, id(doctorId, 'doctor'));
    const [branches, hours, leaves, days] = await Promise.all([
      pool.query('SELECT id, name, timezone, active FROM branches WHERE id = ANY($1) ORDER BY name', [d.branch_ids]),
      pool.query(`SELECT t.id, t.branch_id, b.name branch_name, t.day_of_week, to_char(t.start_time, 'HH24:MI') start_time, to_char(t.end_time, 'HH24:MI') end_time,
                    t.slot_minutes, t.mode, t.effective_from::text, t.effective_to::text
                  FROM availability_templates t JOIN branches b ON b.id = t.branch_id WHERE t.doctor_id = $1 ORDER BY t.day_of_week, t.start_time`, [d.id]),
      pool.query(`SELECT id, from_date::text, to_date::text, reason FROM doctor_leaves WHERE doctor_id = $1 AND to_date >= current_date - 1 ORDER BY from_date`, [d.id]),
      pool.query(`SELECT ${LOCAL_DATE}::text AS day, count(*) FILTER (WHERE s.status = 'OPEN')::int open, count(*) FILTER (WHERE s.status = 'BLOCKED')::int blocked,
                    count(*) FILTER (WHERE s.status IN ('BOOKED','HELD'))::int booked
                  FROM slots s JOIN branches b ON b.id = s.branch_id
                  WHERE s.doctor_id = $1 AND s.starts_at > now() AND s.starts_at < now() + interval '14 days' GROUP BY 1 ORDER BY 1`, [d.id]),
    ]);
    return {
      doctor: { id: d.id, name: d.name, status: d.status },
      horizonDays: HORIZON_DAYS,
      branches: branches.rows,
      hours: hours.rows.map((h) => ({ id: h.id, branchId: h.branch_id, branchName: h.branch_name, dayOfWeek: h.day_of_week, startTime: h.start_time, endTime: h.end_time, slotMinutes: h.slot_minutes, mode: h.mode, effectiveFrom: h.effective_from, effectiveTo: h.effective_to })),
      leaves: leaves.rows.map((l) => ({ id: l.id, fromDate: l.from_date, toDate: l.to_date, reason: l.reason })),
      next14Days: days.rows,
    };
  }

  @Post('doctors/:doctorId/availability')
  async addHours(@Param('doctorId') doctorId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const input = parse(AddHours, body);
    if (input.mode === 'VIDEO' && !POLICY.videoEnabled) throw new DomainError(422, 'VIDEO_NOT_AVAILABLE', 'video consultations are not available yet (they need a video room); add in-person hours');
    return this.db.tx(async (c) => {
      const d = await this.svc.assertCanManage(c, actor, id(doctorId, 'doctor'));
      await this.svc.assertCanManageAt(actor, d, input.branchId);
      return this.svc.addHours(c, d, { ...input, effectiveFrom: input.effectiveFrom ?? today() }, actor.id);
    });
  }

  @Delete('doctors/:doctorId/availability/:templateId')
  async removeHours(@Param('doctorId') doctorId: string, @Param('templateId') templateId: string, @CurrentActor() actor: Actor) {
    return this.db.tx(async (c) => {
      const d = await this.svc.assertCanManage(c, actor, id(doctorId, 'doctor'));
      return this.svc.removeHours(c, d.id, id(templateId, 'hours'));
    });
  }

  @Post('doctors/:doctorId/leaves')
  async addLeave(@Param('doctorId') doctorId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const input = parse(AddLeave, body);
    return this.db.tx(async (c) => {
      const d = await this.svc.assertCanManage(c, actor, id(doctorId, 'doctor'));
      return this.svc.addLeave(c, d.id, input, actor.id);
    });
  }

  @Delete('doctors/:doctorId/leaves/:leaveId')
  @HttpCode(200)
  async removeLeave(@Param('doctorId') doctorId: string, @Param('leaveId') leaveId: string, @CurrentActor() actor: Actor) {
    return this.db.tx(async (c) => {
      const d = await this.svc.assertCanManage(c, actor, id(doctorId, 'doctor'));
      return this.svc.removeLeave(c, d.id, id(leaveId, 'leave'));
    });
  }

  /** Slots on one local date (staff view, every status). */
  @Get('doctors/:doctorId/slots')
  async slots(@Param('doctorId') doctorId: string, @Query('date') date: string, @CurrentActor() actor: Actor) {
    const pool = await this.db.current();
    const d = await this.svc.assertCanManage(pool, actor, id(doctorId, 'doctor'));
    const day = parse(z.object({ date: DateStr }), { date }).date;
    const { rows } = await pool.query(
      `SELECT s.id, s.starts_at, s.ends_at, to_char(s.starts_at AT TIME ZONE b.timezone, 'HH24:MI') local_time, s.status, s.mode, b.name branch_name
       FROM slots s JOIN branches b ON b.id = s.branch_id WHERE s.doctor_id = $1 AND ${LOCAL_DATE} = $2 ORDER BY s.starts_at`,
      [d.id, day],
    );
    return rows.map((r) => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at, localTime: r.local_time, status: r.status, mode: r.mode, branchName: r.branch_name }));
  }
}
