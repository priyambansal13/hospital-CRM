import { Injectable } from '@nestjs/common';
import { EventTypes } from '@mc/contracts';
import { conflict, DomainError, notFound } from '@mc/nest-common';
import { assertInBranch, branchesFor, EntitlementsClient, inBranch } from '@mc/entitlements-sdk';
import { type Actor, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { AppointmentsService, toAppointment } from './appointments.service.js';

export const CHECKIN = 'appointment:checkin:branch';
/** start or finish someone else's visit (the doctor does their own); not a desk default (review B-4) */
export const VISIT = 'visit:manage:branch';
/** CONFIRMED appointments this long past their end, never checked in, become NO_SHOW. */
export const NO_SHOW_GRACE_MINUTES = Number(process.env.NO_SHOW_GRACE_MINUTES ?? 60);

/** Today's date at a branch (the queue day). */
const TODAY_AT = (branch: string) => `(now() AT TIME ZONE (SELECT timezone FROM branches WHERE id = ${branch}))::date`;

const QUEUE_SELECT = `
  SELECT a.*, d.name AS doctor_name, d.user_id AS doctor_user_id, b.name AS branch_name, b.timezone,
         to_char(a.local_date, 'YYYY-MM-DD') AS local_date,
         to_char(a.starts_at AT TIME ZONE b.timezone, 'HH24:MI') AS local_time
  FROM appointments a JOIN doctors d ON d.id = a.doctor_id JOIN branches b ON b.id = a.branch_id`;

/** Queue order: being seen, then waiting by token, then not yet arrived by time, then finished. */
const QUEUE_ORDER = `ORDER BY CASE a.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'CHECKED_IN' THEN 1 WHEN 'CONFIRMED' THEN 2 ELSE 3 END,
  CASE WHEN a.status = 'CHECKED_IN' THEN a.token_no END, a.starts_at`;

/**
 * The visit lifecycle after booking (docs/LLD.md §5.7):
 * CONFIRMED → CHECKED_IN (token) → IN_PROGRESS → COMPLETED, or → NO_SHOW. Video visits skip check-in.
 * Every change is one conditional UPDATE (status must still be what we expect) plus an outbox event, which the
 * realtime gateway turns into a push to the doctor's and the desk's screens.
 */
@Injectable()
export class QueueService {
  constructor(private readonly db: TenantDbRouter, private readonly appts: AppointmentsService, private readonly entitlements: EntitlementsClient) {}

  caps(actor: Actor) {
    return this.entitlements.capabilities(TenantContext.require().id, actor);
  }

  /**
   * A doctor sees their own queue; desk staff (check-in permission) see queues at their branches (review B-1).
   * `branches`: which of the doctor's branches the caller may see (null = all).
   */
  async assertQueueAccess(c: Queryable, actor: Actor, doctorId: string): Promise<{ id: string; name: string; user_id: string | null; branches: string[] | null }> {
    const { rows } = await c.query('SELECT id, name, user_id, branch_ids FROM doctors WHERE id = $1', [doctorId]);
    if (!rows[0]) throw notFound('doctor');
    if (actor.kind === 'staff' && rows[0].user_id === actor.id) return { ...rows[0], branches: null };
    const scope = branchesFor(await this.caps(actor), CHECKIN);
    if (scope === null) return { ...rows[0], branches: null };
    const shared = (rows[0].branch_ids as string[]).filter((b) => scope.includes(b));
    if (shared.length) return { ...rows[0], branches: shared };
    throw notFound('doctor');
  }

  async assertBranchAccess(c: Queryable, actor: Actor, branchId: string) {
    const caps = await this.caps(actor);
    if (!caps.permissions.includes(CHECKIN)) throw new DomainError(403, 'PERMISSION_DENIED', `missing permission ${CHECKIN}`, { permission: CHECKIN });
    assertInBranch(caps, CHECKIN, branchId, 'branch', false);
    const { rows } = await c.query('SELECT id, name, timezone FROM branches WHERE id = $1 AND active', [branchId]);
    if (!rows[0]) throw notFound('branch');
    return rows[0];
  }

  /** One doctor's queue for a day (all branches they work at that day, or only `branches`). */
  async queue(doctorId: string, date: string | undefined, branches: string[] | null = null) {
    const pool = await this.db.current();
    const { rows } = await pool.query(
      `${QUEUE_SELECT} WHERE a.doctor_id = $1 AND a.local_date = coalesce($2::date, ${TODAY_AT('a.branch_id')})
         AND ($3::uuid[] IS NULL OR a.branch_id = ANY($3))
         AND a.status NOT IN ('CANCELLED','RESCHEDULED','EXPIRED','PENDING_PAYMENT') ${QUEUE_ORDER}`, [doctorId, date ?? null, branches]);
    return rows.map(toAppointment);
  }

  /** Front desk board: every doctor at a branch with their day's appointments. */
  async board(branch: { id: string; name: string; timezone: string }, date: string | undefined) {
    const pool = await this.db.current();
    const { rows: [{ day }] } = await pool.query(`SELECT to_char(coalesce($1::date, (now() AT TIME ZONE $2)::date), 'YYYY-MM-DD') AS day`, [date ?? null, branch.timezone]);
    const { rows: doctors } = await pool.query(
      `SELECT id, name, status FROM doctors WHERE $1 = ANY(branch_ids) AND status <> 'INACTIVE' ORDER BY name`, [branch.id]);
    const { rows } = await pool.query(
      `${QUEUE_SELECT} WHERE a.branch_id = $1 AND a.local_date = $2::date AND a.status NOT IN ('RESCHEDULED','EXPIRED','PENDING_PAYMENT') ${QUEUE_ORDER}`, [branch.id, day]);
    const appts = rows.map(toAppointment);
    const count = (s: string) => appts.filter((a) => a.status === s).length;
    return {
      branch: { id: branch.id, name: branch.name, timezone: branch.timezone }, date: day,
      totals: { booked: appts.filter((a) => a.status !== 'CANCELLED').length, waiting: count('CHECKED_IN'), inProgress: count('IN_PROGRESS'), completed: count('COMPLETED'), noShow: count('NO_SHOW') },
      doctors: doctors.map((d) => ({ id: d.id, name: d.name, status: d.status, appointments: appts.filter((a) => a.doctor.id === d.id) })),
    };
  }

  /** Patient arrived: CONFIRMED → CHECKED_IN with the next token for (doctor, branch, day). Only on the visit day. */
  async checkIn(c: Queryable, actor: Actor, id: string) {
    const a = await this.load(c, id);
    assertInBranch(await this.caps(actor), CHECKIN, a.branch_id, 'appointment');
    if (a.status === 'CHECKED_IN') throw conflict('ALREADY_CHECKED_IN', `already checked in${a.token_no ? ` (token ${a.token_no})` : ''}`);
    if (a.status !== 'CONFIRMED') throw conflict('INVALID_STATE_TRANSITION', `a ${a.status.toLowerCase().replace('_', ' ')} appointment cannot be checked in`);
    if (a.mode === 'VIDEO') throw new DomainError(422, 'VIDEO_VISIT', 'video visits do not check in at the desk');
    const { rows: [{ today }] } = await c.query(`SELECT a.local_date = ${TODAY_AT('a.branch_id')} AS today FROM appointments a WHERE a.id = $1`, [id]);
    if (!today) throw new DomainError(422, 'NOT_TODAY', `this appointment is on ${a.local_date}; patients can only check in on the day`);

    const tokens = (await this.caps(actor)).features['front_desk.queue_tokens']?.enabled !== false;
    let token: number | null = null;
    if (tokens) {
      const { rows } = await c.query(
        `INSERT INTO daily_counters (doctor_id, branch_id, day, last_token) VALUES ($1, $2, $3, 1)
         ON CONFLICT (doctor_id, branch_id, day) DO UPDATE SET last_token = daily_counters.last_token + 1 RETURNING last_token`,
        [a.doctor_id, a.branch_id, a.local_date]);
      token = rows[0].last_token;
    }
    return this.move(c, a, ['CONFIRMED'], 'CHECKED_IN', EventTypes.appointmentCheckedIn,
      `token_no = $3, checked_in_at = now(), checked_in_by = $4`, [token, actor.id]);
  }

  /** Doctor calls the patient in. One visit at a time per doctor. Video visits start straight from CONFIRMED. */
  async start(c: Queryable, actor: Actor, id: string) {
    const a = await this.load(c, id);
    await this.assertActsFor(actor, a, VISIT);
    const from = a.mode === 'VIDEO' ? ['CONFIRMED', 'CHECKED_IN'] : ['CHECKED_IN'];
    if (!from.includes(a.status)) {
      throw conflict('INVALID_STATE_TRANSITION', a.status === 'CONFIRMED' ? 'check the patient in at the desk first' : `a ${a.status.toLowerCase().replace('_', ' ')} visit cannot be started`);
    }
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`queue:${a.doctor_id}`]);
    const { rows: busy } = await c.query(`SELECT patient_name, token_no FROM appointments WHERE doctor_id = $1 AND status = 'IN_PROGRESS' AND id <> $2 LIMIT 1`, [a.doctor_id, id]);
    if (busy[0]) throw conflict('DOCTOR_BUSY', `finish the current visit first (${busy[0].patient_name}${busy[0].token_no ? `, token ${busy[0].token_no}` : ''})`);
    return this.move(c, a, from, 'IN_PROGRESS', EventTypes.appointmentStarted, 'started_at = now()', []);
  }

  /** The visit's note must be signed (records-service is asked; if it cannot answer, the visit is not blocked). */
  async assertNoteSigned(appointmentId: string) {
    const t = TenantContext.require();
    const res = await fetch(`${process.env.SVC_URL_RECORDS ?? 'http://localhost:4410'}/internal/tenants/${t.id}/encounters/status?appointmentId=${appointmentId}`, {
      headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    if (!res?.ok) return;
    const e = (await res.json()) as { status: string | null };
    if (e.status === 'OPEN') throw conflict('NOTE_NOT_SIGNED', 'the visit note is not signed yet: sign it first, or finish the visit and sign it later');
  }

  async complete(c: Queryable, actor: Actor, id: string) {
    const a = await this.load(c, id);
    await this.assertActsFor(actor, a, VISIT);
    if (a.status !== 'IN_PROGRESS') throw conflict('INVALID_STATE_TRANSITION', 'only a visit in progress can be completed');
    return this.move(c, a, ['IN_PROGRESS'], 'COMPLETED', EventTypes.appointmentCompleted, 'completed_at = now()', []);
  }

  /** Did not come (CONFIRMED, once the time has come) or left before being seen (CHECKED_IN). The slot stays used. */
  async noShow(c: Queryable, actor: Actor, id: string) {
    const a = await this.load(c, id);
    await this.assertActsFor(actor, a, CHECKIN);
    if (!['CONFIRMED', 'CHECKED_IN'].includes(a.status)) throw conflict('INVALID_STATE_TRANSITION', `a ${a.status.toLowerCase().replace('_', ' ')} appointment cannot be marked as no-show`);
    if (a.status === 'CONFIRMED' && new Date(a.starts_at).getTime() > Date.now()) throw new DomainError(422, 'NOT_DUE_YET', 'the appointment time has not come yet');
    return this.move(c, a, ['CONFIRMED', 'CHECKED_IN'], 'NO_SHOW', EventTypes.appointmentNoShow, 'no_show_at = now()', []);
  }

  /**
   * Job: CONFIRMED appointments that ended more than `graceMinutes` ago and never checked in become NO_SHOW.
   * Returns how many were marked. Runs per hospital (see NoShowJob).
   */
  async markNoShows(c: Queryable, graceMinutes: number): Promise<number> {
    const { rows } = await c.query(
      `UPDATE appointments SET status = 'NO_SHOW', no_show_at = now(), version = version + 1, updated_at = now()
       WHERE status = 'CONFIRMED' AND ends_at < now() - make_interval(mins => $1) RETURNING id`, [graceMinutes]);
    for (const r of rows) await this.appts.emit(c, EventTypes.appointmentNoShow, await this.appts.find(c, r.id));
    return rows.length;
  }

  /**
   * The doctor of the visit, or staff holding `permission` at the visit's branch. Starting and finishing a visit is the
   * doctor's (VISIT is not a desk default: the desk starting a visit blocked the doctor with DOCTOR_BUSY, review B-4);
   * the desk marks no-shows (CHECKIN).
   */
  private async assertActsFor(actor: Actor, a: any, permission: string) {
    if (actor.kind === 'staff' && a.doctor_user_id === actor.id) return;
    const caps = await this.caps(actor);
    if (inBranch(caps, permission, a.branch_id)) return;
    if (inBranch(caps, CHECKIN, a.branch_id)) throw new DomainError(403, 'PERMISSION_DENIED', 'only the doctor starts and finishes their visits', { permission });
    throw notFound('appointment');
  }

  private async load(c: Queryable, id: string) {
    const { rows } = await c.query(`${QUEUE_SELECT} WHERE a.id = $1`, [id]);
    if (!rows[0]) throw notFound('appointment');
    return rows[0];
  }

  private async move(c: Queryable, a: any, from: string[], to: string, event: string, set: string, args: unknown[]) {
    const { rowCount } = await c.query(
      `UPDATE appointments SET status = '${to}', ${set}, version = version + 1, updated_at = now() WHERE id = $1 AND status = ANY($2)`,
      [a.id, from, ...args]);
    if (!rowCount) throw conflict('VERSION_CONFLICT', 'the appointment just changed; reload and try again');
    const updated = await this.appts.find(c, a.id);
    await this.appts.emit(c, event, updated);
    return toAppointment(updated);
  }
}
