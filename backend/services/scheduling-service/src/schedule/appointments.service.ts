import { Injectable } from '@nestjs/common';
import { type AppointmentChanged, EventTypes, Topics } from '@mc/contracts';
import { conflict, DomainError, forbidden, notFound } from '@mc/nest-common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { BillingClient, type OnlineCheckout } from './billing.client.js';
import { type PatientAccess, PatientsClient } from './patients.client.js';
import { REFUND_POLICY } from './refund-policy.js';
import { LOCAL_DATE } from './slots.sql.js';

/** Booking policy (hospital-configurable settings arrive in Phase 20). */
export const POLICY = {
  maxActivePerPatient: Number(process.env.BOOKING_MAX_ACTIVE ?? 5),
  minLeadMinutes: Number(process.env.BOOKING_MIN_LEAD_MINUTES ?? 15),
  cancelWindowHours: Number(process.env.BOOKING_CANCEL_WINDOW_HOURS ?? 2),
  // video consultations need a meeting room (Phase 28): until then video hours can't be added or booked (review D-1)
  get videoEnabled() { return process.env.VIDEO_CONSULTS_ENABLED === 'true'; },
  maxReschedules: Number(process.env.BOOKING_MAX_RESCHEDULES ?? 2),
  /** how long a walk-in (no slot) is assumed to take, for overlap checks */
  walkInMinutes: Number(process.env.WALK_IN_MINUTES ?? 15),
  /** an online booking holds its slot this long while the patient pays */
  holdMinutes: Number(process.env.PAYMENT_HOLD_MINUTES ?? 10),
};

export const LIVE = `('PENDING_PAYMENT','CONFIRMED','CHECKED_IN','IN_PROGRESS')`;
const UNIQUE_VIOLATION = '23505';
/** money still held for the appointment (a partial refund leaves the rest refundable) */
const HAS_PAID_MONEY = ['PAID', 'PARTIALLY_REFUNDED'];

const APPT_SELECT = `
  SELECT a.*, d.name AS doctor_name, d.user_id AS doctor_user_id, b.name AS branch_name, b.timezone,
         to_char(a.starts_at AT TIME ZONE b.timezone, 'YYYY-MM-DD') AS local_date,
         to_char(a.starts_at AT TIME ZONE b.timezone, 'HH24:MI') AS local_time
  FROM appointments a JOIN doctors d ON d.id = a.doctor_id JOIN branches b ON b.id = a.branch_id`;

export const toAppointment = (r: any) => ({
  id: r.id, appointmentNo: r.appointment_no, status: r.status,
  patient: { id: r.patient_id, name: r.patient_name, mrn: r.patient_mrn },
  doctor: { id: r.doctor_id, name: r.doctor_name },
  branch: { id: r.branch_id, name: r.branch_name, timezone: r.timezone },
  startsAt: r.starts_at, endsAt: r.ends_at, localDate: r.local_date, localTime: r.local_time, mode: r.mode,
  reason: r.reason, fee: r.fee == null ? null : Number(r.fee), paymentMode: r.payment_mode,
  rescheduledFrom: r.rescheduled_from, rescheduleCount: r.reschedule_count, cancelReason: r.cancel_reason, cancelledAt: r.cancelled_at,
  source: r.source, tokenNo: r.token_no, checkedInAt: r.checked_in_at, startedAt: r.started_at, completedAt: r.completed_at, noShowAt: r.no_show_at,
  paymentStatus: r.payment_status, invoiceId: r.invoice_id, paidAt: r.paid_at, holdExpiresAt: r.hold_expires_at,
  version: r.version, createdAt: r.created_at,
});

/** Who the appointment is for, and how it is being booked. */
export interface Booking {
  patient: PatientAccess;
  reason: string | null;
  /** ONLINE = the patient (policy rules apply); DESK = front desk into a slot (lead time and booking cap waived) */
  source: 'ONLINE' | 'DESK';
  /** ONLINE = hold the slot until paid (PENDING_PAYMENT); AT_CLINIC = confirmed now, paid at the hospital */
  paymentMode?: 'ONLINE' | 'AT_CLINIC';
}
export type AppointmentDto = ReturnType<typeof toAppointment>;

@Injectable()
export class AppointmentsService {
  constructor(private readonly db: TenantDbRouter, private readonly patients: PatientsClient, private readonly entitlements: EntitlementsClient, private readonly billing: BillingClient) {}

  async find(c: Queryable, id: string) {
    const { rows } = await c.query(`${APPT_SELECT} WHERE a.id = $1`, [id]);
    return rows[0];
  }

  /**
   * Who may see/change an appointment: the patient account that owns it, the doctor it is with, or staff with the
   * given branch-level permission. Anyone else gets 404 (existence is not revealed).
   */
  async assertAccess(c: Queryable, actor: Actor, id: string, staffPermission: string) {
    const r = await this.find(c, id);
    if (!r) throw notFound('appointment');
    if (actor.kind === 'patient') {
      if (r.account_person_id !== actor.id) throw notFound('appointment');
      return { row: r, as: 'patient' as const };
    }
    if (r.doctor_user_id === actor.id) return { row: r, as: 'doctor' as const };
    const caps = await this.entitlements.capabilities(TenantContext.require().id, actor);
    if (caps.permissions.includes(staffPermission)) return { row: r, as: 'staff' as const };
    throw notFound('appointment');
  }

  /** Book a slot (pay at clinic). docs/LLD.md §5.2: conditional UPDATE + partial unique index. */
  async book(actor: Actor, input: { slotId: string; patientId: string; reason: string | null; paymentMode: 'ONLINE' | 'AT_CLINIC' }) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'staff book through the front desk');
    const tenant = TenantContext.require();
    if (input.paymentMode === 'ONLINE') {
      const caps = await this.entitlements.capabilities(tenant.id, actor);
      if (!caps.modules.includes('billing') || caps.features['billing.online_payments']?.enabled === false) {
        throw new DomainError(422, 'ONLINE_PAYMENT_UNAVAILABLE', 'this hospital does not take online payments; choose pay at the hospital');
      }
    }
    const patient = await this.patients.access(tenant.id, input.patientId, actor.id);
    const appt = await this.bookingTx((c) => this.bookSlot(c, actor, input.slotId, { patient, reason: input.reason, source: 'ONLINE', paymentMode: input.paymentMode }));
    if (appt.status !== 'PENDING_PAYMENT') return appt;
    // after commit (never across a network call): open the invoice + gateway order; if billing is down, give the slot back
    let payment: OnlineCheckout;
    try {
      payment = await this.billing.openOnlineInvoice(tenant.id, {
        sourceType: 'APPOINTMENT', sourceId: appt.id, patientId: patient.id, patientName: patient.fullName, patientMrn: patient.mrn,
        accountPersonId: patient.accountPersonId, branchId: appt.branch.id, branchName: appt.branch.name,
        description: `Consultation with ${appt.doctor.name}, ${appt.localDate} ${appt.localTime} (${appt.appointmentNo})`,
        amount: appt.fee!, expiresAt: new Date(appt.holdExpiresAt).toISOString(),
      });
    } catch (e) {
      await this.db.tx((c) => this.expire(c, [appt.id]));
      throw e;
    }
    await this.db.query('UPDATE appointments SET invoice_id = $2 WHERE id = $1', [appt.id, payment.invoiceId]);
    return { ...appt, invoiceId: payment.invoiceId, payment };
  }

  /**
   * Run a booking transaction; a lost race becomes 409 SLOT_UNAVAILABLE with alternatives, read AFTER the transaction
   * has released its connection (reading them inside could exhaust the hospital's small pool under a burst).
   */
  async bookingTx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    try {
      return await this.db.tx(fn);
    } catch (e) {
      if (e instanceof SlotTaken) throw conflict('SLOT_UNAVAILABLE', 'this time was just taken; please pick another', { alternatives: await this.alternatives(e.doctorId, e.after) });
      throw e;
    }
  }

  /**
   * The shared booking path (patients online, front desk), inside the caller's transaction (use bookingTx). Throws
   * SlotTaken when someone else got the slot first.
   */
  async bookSlot(c: Queryable, actor: Actor, slotId: string, b: Booking) {
    const online = b.source === 'ONLINE';
    const { rows: slotRows } = await c.query(
      `SELECT s.*, d.status AS doctor_status, d.branch_fees FROM slots s JOIN doctors d ON d.id = s.doctor_id WHERE s.id = $1`, [slotId]);
    const slot = slotRows[0];
    if (!slot) throw notFound('slot');
    if (slot.mode === 'VIDEO' && !POLICY.videoEnabled) throw new DomainError(422, 'VIDEO_NOT_AVAILABLE', 'video consultations are not available yet; please book an in-person visit');
    const slotFee = (slot.branch_fees as { branchId: string; fee: number }[]).find((f) => f.branchId === slot.branch_id)?.fee ?? null;
    const payOnline = b.paymentMode === 'ONLINE';
    if (payOnline && !(slotFee && slotFee > 0)) throw new DomainError(422, 'NOTHING_TO_PAY', 'this appointment has no fee to pay online');
    if (online ? slot.doctor_status !== 'ACTIVE' : slot.doctor_status === 'INACTIVE') throw new DomainError(422, 'DOCTOR_NOT_BOOKABLE', 'this doctor is not taking bookings');
    await this.assertPatientFree(c, b.patient, slot.starts_at, slot.ends_at, online);

    try {
      // online: at least the lead time ahead; desk: any slot that hasn't ended yet (the patient is standing there)
      // pay online: the slot is HELD for the patient until billing reports the payment (or the hold expires)
      const { rows } = payOnline
        ? await c.query(`UPDATE slots SET status = 'HELD', held_by = $3, held_until = now() + make_interval(mins => $4), version = version + 1
                         WHERE id = $1 AND status = 'OPEN' AND starts_at > now() + make_interval(mins => $2) RETURNING *`, [slotId, POLICY.minLeadMinutes, b.patient.accountPersonId, POLICY.holdMinutes])
        : online
          ? await c.query(`UPDATE slots SET status = 'BOOKED', version = version + 1 WHERE id = $1 AND status = 'OPEN' AND starts_at > now() + make_interval(mins => $2) RETURNING *`, [slotId, POLICY.minLeadMinutes])
          : await c.query(`UPDATE slots SET status = 'BOOKED', version = version + 1 WHERE id = $1 AND status = 'OPEN' AND ends_at > now() RETURNING *`, [slotId]);
      if (!rows[0]) throw new SlotTaken(slot.doctor_id, slot.starts_at);
      const s = rows[0];
      return await this.insert(c, actor, b, { slotId: s.id, doctorId: s.doctor_id, branchId: s.branch_id, startsAt: s.starts_at, endsAt: s.ends_at, mode: s.mode, fee: slotFee, source: b.source, holdUntil: payOnline ? s.held_until : null });
    } catch (e) {
      if ((e as any).code === UNIQUE_VIOLATION) throw new SlotTaken(slot.doctor_id, slot.starts_at);
      throw e;
    }
  }

  /** Front desk: a walk-in with no free slot joins today's queue now (no slot is used). */
  async walkIn(c: Queryable, actor: Actor, doctorId: string, branchId: string, b: Omit<Booking, 'source'>) {
    const { rows } = await c.query(`SELECT * FROM doctors WHERE id = $1`, [doctorId]);
    const d = rows[0];
    if (!d) throw notFound('doctor');
    if (d.status === 'INACTIVE') throw new DomainError(422, 'DOCTOR_NOT_BOOKABLE', 'this doctor is not seeing patients');
    if (!d.branch_ids.includes(branchId)) throw new DomainError(422, 'BRANCH_NOT_ASSIGNED', `${d.name} does not practise at this branch`);
    const now = new Date();
    const end = new Date(now.getTime() + POLICY.walkInMinutes * 60_000);
    await this.assertPatientFree(c, b.patient, now, end, false);
    const fee = (d.branch_fees as { branchId: string; fee: number }[]).find((f) => f.branchId === branchId)?.fee ?? null;
    return this.insert(c, actor, { ...b, source: 'DESK' }, { slotId: null, doctorId, branchId, startsAt: now, endsAt: end, mode: 'IN_PERSON', fee, source: 'WALK_IN' });
  }

  /** No overlapping live appointment for the patient; online bookings also have a cap on upcoming ones. */
  private async assertPatientFree(c: Queryable, patient: PatientAccess, startsAt: Date | string, endsAt: Date | string, online: boolean) {
    const { rows: [counts] } = await c.query(
      `SELECT count(*) FILTER (WHERE starts_at > now())::int AS active,
              count(*) FILTER (WHERE starts_at < $3 AND ends_at > $2)::int AS overlapping
       FROM appointments WHERE patient_id = $1 AND status IN ${LIVE}`,
      [patient.id, startsAt, endsAt],
    );
    if (counts.overlapping) throw conflict('PATIENT_HAS_OVERLAPPING_APPOINTMENT', `${patient.fullName} already has an appointment at this time`);
    if (online && counts.active >= POLICY.maxActivePerPatient) throw new DomainError(422, 'TOO_MANY_ACTIVE_BOOKINGS', `at most ${POLICY.maxActivePerPatient} upcoming appointments per patient`);
  }

  private async insert(c: Queryable, actor: Actor, b: Booking, v: { slotId: string | null; doctorId: string; branchId: string; startsAt: Date | string; endsAt: Date | string; mode: string; fee: number | null; source: string; holdUntil?: Date | string | null }) {
    const id = randomUUID();
    const pending = !!v.holdUntil;
    const { rows: no } = await c.query(`SELECT 'APT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('appointment_seq')::text, 6, '0') AS no`);
    await c.query(
      `INSERT INTO appointments (id, appointment_no, slot_id, patient_id, patient_name, patient_mrn, account_person_id, booked_by, doctor_id, branch_id, starts_at, ends_at, mode, status, reason, fee, source, payment_mode, payment_status, hold_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [id, no[0].no, v.slotId, b.patient.id, b.patient.fullName, b.patient.mrn, b.patient.accountPersonId, actor.id, v.doctorId, v.branchId, v.startsAt, v.endsAt, v.mode,
        pending ? 'PENDING_PAYMENT' : 'CONFIRMED', b.reason, v.fee, v.source, pending ? 'ONLINE' : 'AT_CLINIC', v.fee && v.fee > 0 ? 'UNPAID' : 'NOT_DUE', v.holdUntil ?? null],
    );
    const appt = await this.find(c, id);
    // a pending online booking is announced as booked only once paid (notifications confirm on "booked")
    await this.emit(c, pending ? EventTypes.appointmentPendingPayment : EventTypes.appointmentBooked, appt);
    return toAppointment(appt);
  }

  /** Hours before the visit when patients can no longer cancel/move online: the hospital's setting (default 2). */
  /** The hospital's own cancel/reschedule cutoff (setting appointments.cancel_cutoff_hours, within its plan). */
  cutoffHours() {
    return this.entitlements.setting(TenantContext.require().id, 'appointments.cancel_cutoff_hours', POLICY.cancelWindowHours);
  }

  async cancel(actor: Actor, id: string, reason: string | null) {
    const cutoff = await this.cutoffHours();
    return this.db.tx(async (c) => {
      const { row: a, as } = await this.assertAccess(c, actor, id, 'appointment:cancel:branch');
      if (!['CONFIRMED', 'PENDING_PAYMENT'].includes(a.status)) throw conflict('INVALID_STATE_TRANSITION', `a ${a.status.toLowerCase()} appointment cannot be cancelled`);
      if (as === 'patient' && a.status === 'CONFIRMED' && new Date(a.starts_at).getTime() - Date.now() < cutoff * 3600_000) {
        throw new DomainError(422, 'CANCELLATION_WINDOW_PASSED', `online cancellation closes ${cutoff} hours before the appointment; please call the hospital`);
      }
      const { rowCount } = await c.query(`UPDATE appointments SET status = 'CANCELLED', cancel_reason = $2, cancelled_by = $3, cancelled_at = now(), version = version + 1, updated_at = now() WHERE id = $1 AND version = $4`,
        [id, reason ?? (as === 'patient' ? 'PATIENT_CANCELLED' : 'CANCELLED_BY_HOSPITAL'), actor.id, a.version]);
      if (!rowCount) throw conflict('VERSION_CONFLICT', 'the appointment just changed; reload and try again');
      const freed = await this.releaseSlot(c, a.slot_id);
      const updated = await this.find(c, id);
      const refundPercent = REFUND_POLICY.percent({ paid: HAS_PAID_MONEY.includes(a.payment_status), cancelledBy: as === 'patient' ? 'patient' : 'hospital', startsAt: new Date(a.starts_at) });
      await this.emit(c, EventTypes.appointmentCancelled, updated, { refundPercent });
      if (freed) await this.notifyWaitlist(c, a.doctor_id, a.slot_id);
      return toAppointment(updated);
    });
  }

  /** Move to another slot of the same doctor: new appointment row linked to the old one (docs/LLD.md §4.1). */
  async reschedule(actor: Actor, id: string, newSlotId: string) {
    const pool = await this.db.current();
    const { row: a } = await this.assertAccess(pool, actor, id, 'appointment:cancel:branch');
    if (a.status !== 'CONFIRMED') throw conflict('INVALID_STATE_TRANSITION', `a ${a.status.toLowerCase()} appointment cannot be rescheduled`);
    if (a.reschedule_count >= POLICY.maxReschedules) throw new DomainError(422, 'RESCHEDULE_LIMIT_REACHED', `an appointment can be rescheduled at most ${POLICY.maxReschedules} times`);
    const cutoff = await this.cutoffHours();
    if (actor.kind === 'patient' && new Date(a.starts_at).getTime() - Date.now() < cutoff * 3600_000) {
      throw new DomainError(422, 'CANCELLATION_WINDOW_PASSED', `online changes close ${cutoff} hours before the appointment`);
    }
    if (newSlotId === a.slot_id) throw new DomainError(422, 'SAME_SLOT', 'pick a different time');
    try {
      return await this.db.tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE slots SET status = 'BOOKED', version = version + 1
           WHERE id = $1 AND doctor_id = $2 AND status = 'OPEN' AND starts_at > now() + make_interval(mins => $3) AND (mode = 'IN_PERSON' OR $4) RETURNING *`,
          [newSlotId, a.doctor_id, POLICY.minLeadMinutes, POLICY.videoEnabled],
        );
        if (!rows[0]) throw new SlotTaken(a.doctor_id, new Date());
        const s = rows[0];
        const { rowCount } = await c.query(`UPDATE appointments SET status = 'RESCHEDULED', version = version + 1, updated_at = now() WHERE id = $1 AND version = $2`, [a.id, a.version]);
        if (!rowCount) throw conflict('VERSION_CONFLICT', 'the appointment changed; reload and retry');
        const freed = await this.releaseSlot(c, a.slot_id);
        const newId = randomUUID();
        const { rows: no } = await c.query(`SELECT 'APT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('appointment_seq')::text, 6, '0') AS no`);
        await c.query(
          // the payment travels with the appointment (same doctor; fee differences between branches are not re-billed yet)
          `INSERT INTO appointments (id, appointment_no, slot_id, patient_id, patient_name, patient_mrn, account_person_id, booked_by, doctor_id, branch_id, starts_at, ends_at, mode, status, reason, fee, payment_mode, payment_status, invoice_id, paid_at, source, rescheduled_from, reschedule_count)
           SELECT $1, $2, $3, patient_id, patient_name, patient_mrn, account_person_id, $4, doctor_id, $5, $6, $7, $8, 'CONFIRMED', reason, fee, payment_mode, payment_status, invoice_id, paid_at, source, id, reschedule_count + 1
           FROM appointments WHERE id = $9`,
          [newId, no[0].no, s.id, actor.id, s.branch_id, s.starts_at, s.ends_at, s.mode, a.id],
        );
        const appt = await this.find(c, newId);
        await this.emit(c, EventTypes.appointmentRescheduled, appt);
        if (freed) await this.notifyWaitlist(c, a.doctor_id, a.slot_id);
        return toAppointment(appt);
      });
    } catch (e) {
      if (e instanceof SlotTaken || (e as any).code === UNIQUE_VIOLATION) {
        throw conflict('SLOT_UNAVAILABLE', 'this time was just taken; please pick another', { alternatives: await this.alternatives(a.doctor_id, new Date()) });
      }
      throw e;
    }
  }

  /** Doctor on leave: cancel live appointments in the range (patients are told in Phase 9; refunds in Phase 11). */
  async cancelForLeave(c: Queryable, doctorId: string, fromDate: string, toDate: string, actorId: string): Promise<number> {
    const { rows } = await c.query(
      `UPDATE appointments a SET status = 'CANCELLED', cancel_reason = 'DOCTOR_UNAVAILABLE', cancelled_by = $4, cancelled_at = now(), version = version + 1, updated_at = now()
       FROM branches b WHERE b.id = a.branch_id AND a.doctor_id = $1 AND a.status IN ('CONFIRMED','PENDING_PAYMENT') AND a.starts_at > now()
         AND (a.starts_at AT TIME ZONE b.timezone)::date BETWEEN $2 AND $3
       RETURNING a.id, a.slot_id`,
      [doctorId, fromDate, toDate, actorId],
    );
    for (const r of rows) {
      if (r.slot_id) await c.query(`UPDATE slots SET status = 'BLOCKED', held_by = NULL, held_until = NULL, version = version + 1 WHERE id = $1`, [r.slot_id]);
      const a = await this.find(c, r.id);
      await this.emit(c, EventTypes.appointmentCancelled, a, { refundPercent: REFUND_POLICY.percent({ paid: HAS_PAID_MONEY.includes(a.payment_status), cancelledBy: 'hospital', startsAt: new Date(a.starts_at) }) });
    }
    return rows.length;
  }

  /**
   * The doctor or the branch is no longer available (doctor unpublished, branch deactivated, doctor no longer at a
   * branch): future appointments there are cancelled by the hospital (full refund) and patients are told
   * (docs/ROLE-FLOWS-AND-GAPS.md D-5). Same path as doctor leave. Returns how many.
   */
  async cancelUnavailable(c: Queryable, where: { doctorId?: string; branchId?: string; notAtBranches?: string[] }): Promise<number> {
    const { rows } = await c.query(
      `UPDATE appointments a SET status = 'CANCELLED', cancel_reason = 'DOCTOR_UNAVAILABLE', cancelled_by = NULL, cancelled_at = now(), version = version + 1, updated_at = now()
       WHERE a.status IN ('CONFIRMED','PENDING_PAYMENT') AND a.starts_at > now()
         AND ($1::uuid IS NULL OR a.doctor_id = $1) AND ($2::uuid IS NULL OR a.branch_id = $2)
         AND ($3::uuid[] IS NULL OR NOT (a.branch_id = ANY($3)))
       RETURNING a.id, a.slot_id`,
      [where.doctorId ?? null, where.branchId ?? null, where.notAtBranches ?? null]);
    for (const r of rows) {
      if (r.slot_id) await c.query(`UPDATE slots SET status = 'BLOCKED', held_by = NULL, held_until = NULL, version = version + 1 WHERE id = $1`, [r.slot_id]);
      const a = await this.find(c, r.id);
      await this.emit(c, EventTypes.appointmentCancelled, a, { refundPercent: REFUND_POLICY.percent({ paid: HAS_PAID_MONEY.includes(a.payment_status), cancelledBy: 'hospital', startsAt: new Date(a.starts_at) }) });
    }
    return rows.length;
  }

  /** How many future bookings a change would cancel (admins confirm before unpublishing or deactivating). */
  async upcomingCount(where: { doctorId?: string; branchId?: string }) {
    const { rows: [r] } = await this.db.query(
      `SELECT count(*)::int AS n FROM appointments WHERE status IN ('CONFIRMED','PENDING_PAYMENT') AND starts_at > now()
         AND ($1::uuid IS NULL OR doctor_id = $1) AND ($2::uuid IS NULL OR branch_id = $2)`, [where.doctorId ?? null, where.branchId ?? null]);
    return { upcoming: r.n as number };
  }

  async joinWaitlist(actor: Actor, input: { doctorId: string; date: string; patientId: string }) {
    const tenantId = TenantContext.require().id;
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'only patients can join a waitlist');
    const patient = await this.patients.access(tenantId, input.patientId, actor.id);
    const pool = await this.db.current();
    const { rows: d } = await pool.query(`SELECT 1 FROM doctors WHERE id = $1 AND status = 'ACTIVE'`, [input.doctorId]);
    if (!d[0]) throw notFound('doctor');
    if (input.date < new Date().toISOString().slice(0, 10)) throw new DomainError(422, 'DATE_IN_PAST', 'pick today or a later date');
    const { rows } = await pool.query(
      `INSERT INTO waitlist (id, patient_id, patient_name, account_person_id, doctor_id, date) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (patient_id, doctor_id, date) DO UPDATE SET notified_at = NULL RETURNING id, to_char(date, 'YYYY-MM-DD') date`,
      [randomUUID(), patient.id, patient.fullName, patient.accountPersonId, input.doctorId, input.date],
    );
    return { id: rows[0].id, doctorId: input.doctorId, date: rows[0].date, patient: { id: patient.id, name: patient.fullName } };
  }

  /** A slot was freed: mark that day's waitlist as notified and announce it (Phase 9 sends the messages). */
  async notifyWaitlist(c: Queryable, doctorId: string, slotId: string) {
    const { rows } = await c.query(
      `UPDATE waitlist w SET notified_at = now() FROM slots s JOIN branches b ON b.id = s.branch_id
       WHERE s.id = $2 AND w.doctor_id = $1 AND w.notified_at IS NULL AND w.date = ${LOCAL_DATE}
       RETURNING w.id, w.patient_id, w.account_person_id, to_char(w.date, 'YYYY-MM-DD') date, (SELECT name FROM doctors WHERE id = w.doctor_id) AS doctor_name`,
      [doctorId, slotId],
    );
    const tenantId = TenantContext.require().id;
    for (const w of rows) {
      await addToOutbox(c, Topics.scheduling, w.id, envelope(EventTypes.waitlistSlotAvailable, { waitlistId: w.id, patientId: w.patient_id, accountPersonId: w.account_person_id, doctorId, doctorName: w.doctor_name, date: w.date, slotId }, { tenantId, subject: w.id }));
    }
    return rows.length;
  }

  /** Free a booked/held slot if it is still in the future (a leave-blocked slot stays blocked). */
  async releaseSlot(c: Queryable, slotId: string | null): Promise<boolean> {
    if (!slotId) return false;
    const { rowCount } = await c.query(`UPDATE slots SET status = 'OPEN', held_by = NULL, held_until = NULL, version = version + 1 WHERE id = $1 AND status IN ('BOOKED','HELD') AND starts_at > now()`, [slotId]);
    return !!rowCount;
  }

  /**
   * Hold expiry and compensation: PENDING_PAYMENT → EXPIRED, held slot back to OPEN (docs/LLD.md §5.4).
   * `ids` = specific appointments (billing unavailable); otherwise every hold past its expiry, in batches.
   */
  async expire(c: Queryable, ids?: string[]): Promise<number> {
    const { rows } = await c.query(
      `UPDATE appointments SET status = 'EXPIRED', version = version + 1, updated_at = now()
       WHERE id IN (SELECT id FROM appointments WHERE status = 'PENDING_PAYMENT' AND ${ids ? 'id = ANY($1)' : 'hold_expires_at < now() AND $1::uuid[] IS NULL'}
                    ORDER BY hold_expires_at LIMIT 500 FOR UPDATE SKIP LOCKED)
       RETURNING id, slot_id, doctor_id`, [ids ?? null]);
    for (const r of rows) {
      const freed = await this.releaseSlot(c, r.slot_id);
      await this.emit(c, EventTypes.appointmentExpired, await this.find(c, r.id));
      if (freed) await this.notifyWaitlist(c, r.doctor_id, r.slot_id);
    }
    return rows.length;
  }

  /**
   * billing.payment_succeeded (docs/LLD.md §5.3). Idempotent. A pending online booking is confirmed; a late payment
   * for an expired hold re-takes the slot if it is still free, otherwise the money goes back (payment_unapplied).
   * A counter payment for a pay-at-clinic appointment just marks it paid.
   */
  async onPaymentSucceeded(c: Queryable, p: { invoiceId: string; paymentId: string; sourceId: string }) {
    const { rows } = await c.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [p.sourceId]);
    const a = rows[0];
    if (!a) return;
    const markPaid = (status: string) => c.query(
      `UPDATE appointments SET status = $2, payment_status = 'PAID', invoice_id = $3, paid_at = coalesce(paid_at, now()), hold_expires_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [a.id, status, p.invoiceId]);
    if (a.payment_status === 'PAID' && a.status !== 'PENDING_PAYMENT') return; // duplicate
    if (a.status === 'PENDING_PAYMENT') {
      const { rowCount } = await c.query(`UPDATE slots SET status = 'BOOKED', held_by = NULL, held_until = NULL, version = version + 1 WHERE id = $1 AND status = 'HELD'`, [a.slot_id]);
      if (rowCount) {
        await markPaid('CONFIRMED');
        await this.emit(c, EventTypes.appointmentBooked, await this.find(c, a.id));
        return;
      }
    }
    if (['EXPIRED', 'PENDING_PAYMENT'].includes(a.status)) {
      // late payment: take the slot back if nobody else has it
      const { rowCount } = await c.query(
        `UPDATE slots SET status = 'BOOKED', held_by = NULL, held_until = NULL, version = version + 1
         WHERE id = $1 AND status = 'OPEN' AND starts_at > now()
           AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.slot_id = $1 AND x.id <> $2 AND x.status IN ${LIVE})`, [a.slot_id, a.id]);
      if (rowCount) {
        await markPaid('CONFIRMED');
        await this.emit(c, EventTypes.appointmentBooked, await this.find(c, a.id));
        return;
      }
      await c.query(`UPDATE appointments SET status = 'EXPIRED', payment_status = 'PAID', invoice_id = $2, paid_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [a.id, p.invoiceId]);
      await addToOutbox(c, Topics.scheduling, a.id, envelope(EventTypes.paymentUnapplied, { appointmentId: a.id, invoiceId: p.invoiceId, paymentId: p.paymentId, reason: 'SLOT_LOST' }, { tenantId: TenantContext.require().id, subject: a.id }));
      return;
    }
    if (a.status === 'CANCELLED') {
      await c.query(`UPDATE appointments SET payment_status = 'PAID', invoice_id = $2, paid_at = now() WHERE id = $1`, [a.id, p.invoiceId]);
      await addToOutbox(c, Topics.scheduling, a.id, envelope(EventTypes.paymentUnapplied, { appointmentId: a.id, invoiceId: p.invoiceId, paymentId: p.paymentId, reason: 'APPOINTMENT_CANCELLED' }, { tenantId: TenantContext.require().id, subject: a.id }));
      return;
    }
    // confirmed / checked in / seen: a counter payment (or a duplicate)
    await c.query(`UPDATE appointments SET payment_status = 'PAID', invoice_id = $2, paid_at = coalesce(paid_at, now()) WHERE id = $1`, [a.id, p.invoiceId]);
  }

  /** billing.refund_processed: reflect the refund on every row that carries the invoice (incl. rescheduled history). */
  async onRefundProcessed(c: Queryable, r: { invoiceId: string; invoiceStatus: string }) {
    const status = r.invoiceStatus === 'REFUNDED' ? 'REFUNDED' : r.invoiceStatus === 'PARTIALLY_REFUNDED' ? 'PARTIALLY_REFUNDED' : null;
    if (status) await c.query('UPDATE appointments SET payment_status = $2 WHERE invoice_id = $1', [r.invoiceId, status]);
  }

  async alternatives(doctorId: string, after: Date | string) {
    const { rows } = await this.db.query(
      `SELECT s.id, s.starts_at, to_char(s.starts_at AT TIME ZONE b.timezone, 'YYYY-MM-DD') local_date, to_char(s.starts_at AT TIME ZONE b.timezone, 'HH24:MI') local_time
       FROM slots s JOIN branches b ON b.id = s.branch_id
       WHERE s.doctor_id = $1 AND s.status = 'OPEN' AND s.starts_at > greatest($2::timestamptz, now() + make_interval(mins => $3)) ORDER BY s.starts_at LIMIT 3`,
      [doctorId, after, POLICY.minLeadMinutes],
    );
    return rows.map((r) => ({ slotId: r.id, startsAt: r.starts_at, localDate: r.local_date, localTime: r.local_time }));
  }

  async emit(c: Queryable, type: string, a: any, extra: Partial<AppointmentChanged> = {}) {
    const data: AppointmentChanged = {
      appointmentId: a.id, appointmentNo: a.appointment_no, patientId: a.patient_id, accountPersonId: a.account_person_id,
      doctorId: a.doctor_id, branchId: a.branch_id, startsAt: new Date(a.starts_at).toISOString(), status: a.status, reason: a.cancel_reason,
      patientName: a.patient_name, patientMrn: a.patient_mrn, doctorName: a.doctor_name, branchName: a.branch_name, localDate: a.local_date, localTime: a.local_time,
      mode: a.mode, fee: a.fee == null ? null : Number(a.fee), rescheduledFrom: a.rescheduled_from,
      tokenNo: a.token_no ?? null, source: a.source,
      paymentMode: a.payment_mode, paymentStatus: a.payment_status, invoiceId: a.invoice_id ?? null,
      ...extra,
    };
    await addToOutbox(c, Topics.scheduling, a.id, envelope(type, data, { tenantId: TenantContext.require().id, subject: a.id }));
  }
}

class SlotTaken extends Error {
  constructor(readonly doctorId: string, readonly after: Date | string) {
    super('slot taken');
  }
}
