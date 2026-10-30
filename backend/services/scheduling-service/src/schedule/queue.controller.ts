import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentActor, Idempotent, Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { assertInBranch, inBranch, RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { AppointmentsService } from './appointments.service.js';
import { PatientsClient } from './patients.client.js';
import { CHECKIN, NO_SHOW_GRACE_MINUTES, QueueService } from './queue.service.js';

const Uuid = z.uuid();
const id = (v: string, what: string) => { if (!Uuid.safeParse(v ?? '').success) throw notFound(what); return v; };
const Day = z.iso.date().optional();

export const DeskBook = z.object({
  patientId: z.uuid(),
  reason: z.string().trim().max(500).nullable().default(null),
  /** book into this open slot... */
  slotId: z.uuid().optional(),
  /** ...or join this doctor's queue at this branch right now, without a slot */
  walkIn: z.object({ doctorId: z.uuid(), branchId: z.uuid() }).optional(),
  /** check the patient in straight away (they are at the desk) */
  checkIn: z.boolean().default(true),
}).refine((b) => !!b.slotId !== !!b.walkIn, 'give either slotId or walkIn');

/** Front desk: today's board, open slots for walk-ins, booking for a patient, check-in. */
@Controller('v1/desk')
@RequireModule('front_desk')
export class DeskController {
  constructor(private readonly db: TenantDbRouter, private readonly queue: QueueService, private readonly appts: AppointmentsService, private readonly patients: PatientsClient) {}

  @Get('board')
  @RequirePermission(CHECKIN)
  async board(@Query('branchId') branchId: string, @Query('date') date: string | undefined, @CurrentActor() actor: Actor) {
    const branch = await this.queue.assertBranchAccess(await this.db.current(), actor, id(branchId, 'branch'));
    return this.queue.board(branch, parse(Day, date));
  }

  /**
   * A doctor's open slots at a branch on a day: today (the rest of it, including the slot running now) or a later date
   * for booking ahead and moving bookings (E-1, E-2).
   */
  @Get('doctors/:doctorId/slots')
  @RequirePermission('walkin:create:branch')
  async todaySlots(@Param('doctorId') doctorId: string, @Query('branchId') branchId: string, @Query('date') date?: string) { // branch checked by the guard (query)
    const day = parse(Day, date) ?? null;
    const { rowCount } = await this.db.query('SELECT 1 FROM doctors WHERE id = $1 AND $2 = ANY(branch_ids)', [id(doctorId, 'doctor'), id(branchId, 'branch')]);
    if (!rowCount) throw notFound('doctor');
    const { rows } = await this.db.query(
      `SELECT s.id, s.starts_at, s.mode, to_char(s.starts_at AT TIME ZONE b.timezone, 'HH24:MI') local_time
       FROM slots s JOIN branches b ON b.id = s.branch_id
       WHERE s.doctor_id = $1 AND s.branch_id = $2 AND s.status = 'OPEN' AND s.mode = 'IN_PERSON' AND s.ends_at > now()
         AND (s.starts_at AT TIME ZONE b.timezone)::date = coalesce($3::date, (now() AT TIME ZONE b.timezone)::date)
       ORDER BY s.starts_at`, [id(doctorId, 'doctor'), id(branchId, 'branch'), day]);
    return rows.map((r) => ({ slotId: r.id, startsAt: r.starts_at, localTime: r.local_time, mode: r.mode, now: new Date(r.starts_at).getTime() <= Date.now() }));
  }

  @Post('appointments')
  @Idempotent()
  @RequirePermission('walkin:create:branch')
  async book(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const input = parse(DeskBook, body);
    const caps = await this.queue.caps(actor);
    // only at the caller's branches (review B-1)
    const branchId = input.walkIn?.branchId ?? (await this.db.query('SELECT branch_id FROM slots WHERE id = $1', [input.slotId])).rows[0]?.branch_id;
    if (!branchId) throw notFound('slot');
    assertInBranch(caps, 'walkin:create:branch', branchId, 'branch', false);
    const patient = await this.patients.get(TenantContext.require().id, input.patientId);
    return this.appts.bookingTx(async (c) => {
      const appt = input.slotId
        ? await this.appts.bookSlot(c, actor, input.slotId, { patient, reason: input.reason, source: 'DESK' })
        : await this.appts.walkIn(c, actor, input.walkIn!.doctorId, input.walkIn!.branchId, { patient, reason: input.reason });
      if (!input.checkIn || !caps.permissions.includes(CHECKIN) || !inBranch(caps, CHECKIN, branchId)) return appt;
      // a slot later today is booked but not checked in yet (the patient may step out)
      if (new Date(appt.startsAt).getTime() - Date.now() > 60 * 60_000) return appt;
      return this.queue.checkIn(c, actor, appt.id);
    });
  }

  @Post('appointments/:id/check-in')
  @HttpCode(200)
  @RequirePermission(CHECKIN)
  checkIn(@Param('id') apptId: string, @CurrentActor() actor: Actor) {
    return this.db.tx((c) => this.queue.checkIn(c, actor, id(apptId, 'appointment')));
  }
}

/** The doctor's queue and the visit lifecycle (doctor for their own visits, desk staff for any). */
@Controller('v1')
@RequireModule('front_desk')
export class QueueController {
  constructor(private readonly db: TenantDbRouter, private readonly queue: QueueService) {}

  @Get('doctors/:doctorId/queue')
  async doctorQueue(@Param('doctorId') doctorId: string, @Query('date') date: string | undefined, @CurrentActor() actor: Actor) {
    const d = await this.queue.assertQueueAccess(await this.db.current(), actor, id(doctorId, 'doctor'));
    return { doctor: { id: d.id, name: d.name }, appointments: await this.queue.queue(d.id, parse(Day, date), d.branches) };
  }

  /** May the caller watch this queue (doctorId) or board (branchId) live? Used by the realtime gateway. */
  @Get('queue/access')
  @HttpCode(204)
  async access(@Query('doctorId') doctorId: string | undefined, @Query('branchId') branchId: string | undefined, @CurrentActor() actor: Actor) {
    const pool = await this.db.current();
    if (doctorId) await this.queue.assertQueueAccess(pool, actor, id(doctorId, 'doctor'));
    else await this.queue.assertBranchAccess(pool, actor, id(branchId ?? '', 'branch'));
  }

  @Post('appointments/:id/start')
  @HttpCode(200)
  start(@Param('id') apptId: string, @CurrentActor() actor: Actor) {
    return this.db.tx((c) => this.queue.start(c, actor, id(apptId, 'appointment')));
  }

  /**
   * A visit is completed once its note is signed; the doctor may knowingly finish first and sign later
   * (`allowUnsigned`, the note then shows in their "Unsigned notes"). docs/ROLE-FLOWS-AND-GAPS.md C-4.
   */
  @Post('appointments/:id/complete')
  @HttpCode(200)
  async complete(@Param('id') apptId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const appointmentId = id(apptId, 'appointment');
    const { allowUnsigned } = parse(z.object({ allowUnsigned: z.boolean().default(false) }), body ?? {});
    if (!allowUnsigned) await this.queue.assertNoteSigned(appointmentId);
    return this.db.tx((c) => this.queue.complete(c, actor, appointmentId));
  }

  @Post('appointments/:id/no-show')
  @HttpCode(200)
  noShow(@Param('id') apptId: string, @CurrentActor() actor: Actor) {
    return this.db.tx((c) => this.queue.noShow(c, actor, id(apptId, 'appointment')));
  }
}

/** Ops/tests: run the no-show sweep for one hospital now. */
@Controller('internal/tenants/:tenantId/queue')
export class InternalQueueController {
  constructor(private readonly db: TenantDbRouter, private readonly queue: QueueService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post('no-show-sweep')
  @Internal()
  @HttpCode(200)
  async sweep(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    const { graceMinutes } = parse(z.object({ graceMinutes: z.number().int().min(0).max(1440).default(NO_SHOW_GRACE_MINUTES) }), body ?? {});
    return TenantContext.run(await this.placements.get(id(tenantId, 'tenant')), async () => ({ marked: await this.db.tx((c) => this.queue.markNoShows(c, graceMinutes)) }));
  }
}
