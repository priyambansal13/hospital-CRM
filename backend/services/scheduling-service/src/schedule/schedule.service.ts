import { Injectable } from '@nestjs/common';
import { type AvailabilityChanged, EventTypes, Topics } from '@mc/contracts';
import { conflict, DomainError, forbidden, notFound } from '@mc/nest-common';
import { assertInBranch, branchesFor, EntitlementsClient } from '@mc/entitlements-sdk';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { AppointmentsService } from './appointments.service.js';
import { GENERATE_SLOTS, LOCAL_DATE } from './slots.sql.js';

export const HORIZON_DAYS = Number(process.env.SLOT_HORIZON_DAYS ?? 60);

export interface DoctorRow { id: string; user_id: string | null; name: string; status: string; branch_ids: string[] }

export interface NewHours {
  days: number[];
  branchId: string;
  startTime: string;   // HH:MM local to the branch
  endTime: string;
  slotMinutes: number;
  mode: 'IN_PERSON' | 'VIDEO';
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
}

@Injectable()
export class ScheduleService {
  constructor(private readonly entitlements: EntitlementsClient, private readonly appointments: AppointmentsService) {}

  async doctor(c: Queryable, id: string): Promise<DoctorRow> {
    const { rows } = await c.query<DoctorRow>('SELECT * FROM doctors WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('doctor');
    return rows[0];
  }

  /**
   * Who may change a doctor's schedule: anyone with schedule:manage:branch (admins), or the doctor themself with
   * schedule:manage:own.
   */
  async assertCanManage(c: Queryable, actor: Actor, doctorId: string): Promise<DoctorRow> {
    const doctor = await this.doctor(c, doctorId);
    const caps = await this.entitlements.capabilities(TenantContext.require().id, actor);
    // admins: doctors working at one of their branches (review B-1)
    const scope = branchesFor(caps, 'schedule:manage:branch'); // [] when not held
    if (scope === null || doctor.branch_ids.some((b) => scope.includes(b))) return doctor;
    if (caps.permissions.includes('schedule:manage:own') && doctor.user_id === actor.id) return doctor;
    throw forbidden('PERMISSION_DENIED', "you can only manage your own schedule");
  }

  /** An admin limited to some branches adds hours only at those; the doctor manages their own anywhere (review B-1). */
  async assertCanManageAt(actor: Actor, doctor: DoctorRow, branchId: string) {
    if (doctor.user_id === actor.id) return;
    assertInBranch(await this.entitlements.capabilities(TenantContext.require().id, actor), 'schedule:manage:branch', branchId, 'branch', false);
  }

  /** Doctors an admin may manage: everyone, or those working at the admin's branches. */
  async manageableBranches(actor: Actor) {
    return branchesFor(await this.entitlements.capabilities(TenantContext.require().id, actor), 'schedule:manage:branch');
  }

  async addHours(c: Queryable, doctor: DoctorRow, h: NewHours, actorId: string) {
    if (!doctor.branch_ids.includes(h.branchId)) throw new DomainError(422, 'BRANCH_NOT_ASSIGNED', 'the doctor does not practise at this branch; add it on the doctor profile first');
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    if (minutes(h.endTime) - minutes(h.startTime) < h.slotMinutes) throw new DomainError(422, 'HOURS_TOO_SHORT', 'end time must be at least one slot after start time');
    // a doctor can't be in two places at once: no overlap on the same weekday across ANY branch (same date range)
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`schedule:${doctor.id}`]);
    const { rows: clash } = await c.query(
      `SELECT t.day_of_week, to_char(t.start_time, 'HH24:MI') s, to_char(t.end_time, 'HH24:MI') e, b.name FROM availability_templates t JOIN branches b ON b.id = t.branch_id
       WHERE t.doctor_id = $1 AND t.day_of_week = ANY($2::smallint[]) AND t.start_time < $4::time AND t.end_time > $3::time
         AND daterange(t.effective_from, t.effective_to, '[]') && daterange($5::date, $6::date, '[]') LIMIT 1`,
      [doctor.id, h.days, h.startTime, h.endTime, h.effectiveFrom, h.effectiveTo],
    );
    if (clash[0]) throw conflict('SCHEDULE_OVERLAP', `overlaps existing hours ${clash[0].s}–${clash[0].e} at ${clash[0].name}`, { conflict: clash[0] });
    const ids: string[] = [];
    for (const day of h.days) {
      const id = randomUUID();
      ids.push(id);
      await c.query(
        `INSERT INTO availability_templates (id, doctor_id, branch_id, day_of_week, start_time, end_time, slot_minutes, mode, effective_from, effective_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, doctor.id, h.branchId, day, h.startTime, h.endTime, h.slotMinutes, h.mode, h.effectiveFrom, h.effectiveTo, actorId],
      );
    }
    const generated = await this.generate(c, doctor.id);
    await this.changed(c, doctor.id, 'hours added');
    return { templateIds: ids, slotsGenerated: generated };
  }

  /** Remove weekly hours: future OPEN/BLOCKED slots go; booked/held ones stay (template link cleared). */
  async removeHours(c: Queryable, doctorId: string, templateId: string) {
    const { rowCount } = await c.query('SELECT 1 FROM availability_templates WHERE id = $1 AND doctor_id = $2', [templateId, doctorId]);
    if (!rowCount) throw notFound('hours');
    const { rowCount: removed } = await c.query(`DELETE FROM slots WHERE template_id = $1 AND status IN ('OPEN','BLOCKED') AND starts_at > now()`, [templateId]);
    await c.query('DELETE FROM availability_templates WHERE id = $1', [templateId]);
    await this.changed(c, doctorId, 'hours removed');
    return { slotsRemoved: removed ?? 0 };
  }

  async addLeave(c: Queryable, doctorId: string, l: { fromDate: string; toDate: string; reason: string | null }, actorId: string) {
    const id = randomUUID();
    await c.query('INSERT INTO doctor_leaves (id, doctor_id, from_date, to_date, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, doctorId, l.fromDate, l.toDate, l.reason, actorId]);
    const { rowCount: blocked } = await c.query(
      `UPDATE slots s SET status = 'BLOCKED', held_by = NULL, held_until = NULL, version = version + 1 FROM branches b
       WHERE b.id = s.branch_id AND s.doctor_id = $1 AND s.status IN ('OPEN','HELD') AND s.starts_at > now() AND ${LOCAL_DATE} BETWEEN $2 AND $3`,
      [doctorId, l.fromDate, l.toDate],
    );
    // booked appointments on those days are cancelled (patients are notified in Phase 9, refunded in Phase 11)
    const cancelled = await this.appointments.cancelForLeave(c, doctorId, l.fromDate, l.toDate, actorId);
    await this.changed(c, doctorId, 'leave added');
    return { leaveId: id, slotsBlocked: blocked ?? 0, appointmentsCancelled: cancelled };
  }

  async removeLeave(c: Queryable, doctorId: string, leaveId: string) {
    const { rows } = await c.query('DELETE FROM doctor_leaves WHERE id = $1 AND doctor_id = $2 RETURNING from_date, to_date', [leaveId, doctorId]);
    if (!rows[0]) throw notFound('leave');
    const { rowCount: reopened } = await c.query(
      `UPDATE slots s SET status = 'OPEN', version = version + 1 FROM branches b
       WHERE b.id = s.branch_id AND s.doctor_id = $1 AND s.status = 'BLOCKED' AND s.template_id IS NOT NULL AND s.starts_at > now()
         AND ${LOCAL_DATE} BETWEEN $2 AND $3
         AND NOT EXISTS (SELECT 1 FROM doctor_leaves l WHERE l.doctor_id = $1 AND ${LOCAL_DATE} BETWEEN l.from_date AND l.to_date)`,
      [doctorId, rows[0].from_date, rows[0].to_date],
    );
    await this.changed(c, doctorId, 'leave removed');
    return { slotsReopened: reopened ?? 0 };
  }

  /** Fill the rolling window for one doctor (idempotent). */
  async generate(c: Queryable, doctorId: string): Promise<number> {
    const r = await c.query(GENERATE_SLOTS, [doctorId, HORIZON_DAYS]);
    return r.rowCount ?? 0;
  }

  async changed(c: Queryable, doctorId: string, reason: string) {
    const data: AvailabilityChanged = { doctorId, reason };
    await addToOutbox(c, Topics.scheduling, doctorId, envelope(EventTypes.availabilityChanged, data, { tenantId: TenantContext.require().id, subject: doctorId }));
  }
}
