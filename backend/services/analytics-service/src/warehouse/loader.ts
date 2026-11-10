import { Injectable } from '@nestjs/common';
import { AppointmentChanged, BranchChanged, DoctorChanged, type EventEnvelope, EventTypes, LabOrderChanged, LabReportPublished, PatientRegistered, PaymentSucceeded, RefundProcessed } from '@mc/contracts';
import { type Queryable, TenantContext } from '@mc/tenancy';
import { createHmac, randomBytes } from 'node:crypto';

/** One appointment as the warehouse needs it (from an event or from scheduling's backfill). */
export interface AppointmentFact {
  id: string; patientId: string; doctorId: string; branchId: string; startsAt: string; localDate?: string | null; status: string;
  mode?: string | null; source?: string | null; bookedVia?: string | null; paymentMode?: string | null; fee?: number | null;
  bookedAt: string; rescheduledFrom?: string | null; campaign?: string | null;
}
export interface LabOrderFact {
  id: string; patientId: string; branchId: string | null; status: string; total: number; collectionType?: string | null; testCount: number;
  orderedAt: string; collectedAt?: string | null; inLabAt?: string | null; publishedAt?: string | null; tatBreached?: boolean;
  abnormalCount?: number; criticalCount?: number;
}
export interface PaymentFact {
  id: string; kind: 'PAYMENT' | 'REFUND'; invoiceId: string; sourceType: string; sourceId: string; branchId: string | null;
  amount: number; channel: string | null; method: string | null; at: string;
}
export interface PatientFact { patientId: string; registeredAt: string; dob: string | null; gender: string | null }

/** Age band at registration: enough for reports, never a date of birth. */
export function ageBand(dob: string | null, at: string): string | null {
  if (!dob) return null;
  const age = Math.floor((Date.parse(at) - Date.parse(`${dob}T00:00:00Z`)) / (365.25 * 86_400_000));
  if (!Number.isFinite(age) || age < 0) return null;
  return age < 18 ? '0-17' : age < 30 ? '18-29' : age < 45 ? '30-44' : age < 60 ? '45-59' : age < 75 ? '60-74' : '75+';
}

const LOCAL = (tsParam: string, branchParam: string) =>
  `(${tsParam}::timestamptz AT TIME ZONE coalesce((SELECT timezone FROM dim_branches WHERE id = ${branchParam}::uuid), 'Asia/Kolkata'))`;

/**
 * Writes the warehouse. Every write is an idempotent upsert keyed by the source id, and appointment / lab rows keep
 * the newest event (event_at), so redelivered or out-of-order events and a backfill running beside the consumers
 * agree. Patients become a keyed hash (HMAC with a random per-hospital key kept in `settings`).
 */
@Injectable()
export class WarehouseLoader {
  private readonly salts = new Map<string, string>();

  async patientKey(c: Queryable, patientId: string) {
    const tenant = TenantContext.require().id;
    let salt = this.salts.get(tenant);
    if (!salt) {
      await c.query(`INSERT INTO settings (key, value) VALUES ('patient_key_salt', $1) ON CONFLICT (key) DO NOTHING`, [randomBytes(32).toString('hex')]);
      salt = (await c.query(`SELECT value FROM settings WHERE key = 'patient_key_salt'`)).rows[0].value as string;
      this.salts.set(tenant, salt);
    }
    return createHmac('sha256', salt).update(patientId).digest('hex').slice(0, 32);
  }

  // ---------- dimensions ----------

  async branch(c: Queryable, b: { id: string; name: string; timezone?: string | null; active?: boolean }) {
    await c.query(`INSERT INTO dim_branches (id, name, timezone, active) VALUES ($1,$2,$3,$4)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, timezone = excluded.timezone, active = excluded.active`, [b.id, b.name, b.timezone ?? 'Asia/Kolkata', b.active ?? true]);
  }

  async doctor(c: Queryable, d: { id: string; name: string; specialtyCodes: string[]; branchIds: string[]; status?: string }) {
    await c.query(`INSERT INTO dim_doctors (id, name, specialty_codes, branch_ids, status) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, specialty_codes = excluded.specialty_codes, branch_ids = excluded.branch_ids, status = excluded.status`,
      [d.id, d.name, d.specialtyCodes, d.branchIds, d.status ?? 'ACTIVE']);
    // appointments booked before the doctor's specialty was known
    await c.query(`UPDATE fact_appointments SET specialty_code = $2 WHERE doctor_id = $1 AND specialty_code IS NULL AND $2::text IS NOT NULL`, [d.id, d.specialtyCodes[0] ?? null]);
  }

  async specialty(c: Queryable, s: { code: string; name: string }) {
    await c.query(`INSERT INTO dim_specialties (code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name = excluded.name`, [s.code, s.name]);
  }

  // ---------- facts ----------

  async appointment(c: Queryable, a: AppointmentFact, eventAt: string) {
    const key = await this.patientKey(c, a.patientId);
    await c.query(
      `INSERT INTO fact_appointments (appointment_id, patient_key, doctor_id, branch_id, specialty_code, local_date, hour, starts_at, mode, source, booked_via, payment_mode, status, fee, booked_at, lead_days, first_visit, event_at, campaign)
       VALUES ($1, $2, $3, $4, (SELECT specialty_codes[1] FROM dim_doctors WHERE id = $3),
               coalesce($6::date, ${LOCAL('$5', '$4')}::date), extract(hour FROM ${LOCAL('$5', '$4')})::smallint, $5,
               $7, $8, $9, $10, $11, $12, $13, greatest(0, floor(extract(epoch FROM ($5::timestamptz - $13::timestamptz)) / 86400))::int,
               NOT EXISTS (SELECT 1 FROM fact_appointments p WHERE p.patient_key = $2 AND p.starts_at < $5 AND p.appointment_id <> $1 AND p.status IN ('COMPLETED','CHECKED_IN','IN_PROGRESS')),
               $14, $15)
       ON CONFLICT (appointment_id) DO UPDATE SET status = excluded.status, mode = excluded.mode, payment_mode = excluded.payment_mode, fee = excluded.fee,
         booked_via = coalesce(excluded.booked_via, fact_appointments.booked_via), campaign = coalesce(excluded.campaign, fact_appointments.campaign), source = coalesce(excluded.source, fact_appointments.source), event_at = excluded.event_at
       WHERE fact_appointments.event_at <= excluded.event_at`,
      [a.id, key, a.doctorId, a.branchId, a.startsAt, a.localDate ?? null, a.mode ?? null, a.source ?? null, a.bookedVia ?? null, a.paymentMode ?? null, a.status, a.fee ?? null, a.bookedAt, eventAt, a.campaign ?? null]);
    if (a.rescheduledFrom) await c.query(`UPDATE fact_appointments SET status = 'RESCHEDULED', event_at = greatest(event_at, $2) WHERE appointment_id = $1`, [a.rescheduledFrom, eventAt]);
  }

  async labOrder(c: Queryable, o: LabOrderFact, eventAt: string) {
    const key = await this.patientKey(c, o.patientId);
    await c.query(
      `INSERT INTO fact_lab_orders (order_id, patient_key, branch_id, status, total, collection_type, test_count, local_date, ordered_at, collected_at, in_lab_at, published_at, tat_breached, abnormal_count, critical_count, event_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, ${LOCAL('$8', '$3')}::date, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (order_id) DO UPDATE SET
         status = CASE WHEN fact_lab_orders.event_at <= excluded.event_at THEN excluded.status ELSE fact_lab_orders.status END,
         branch_id = coalesce(excluded.branch_id, fact_lab_orders.branch_id), total = excluded.total,
         collected_at = coalesce(fact_lab_orders.collected_at, excluded.collected_at), in_lab_at = coalesce(fact_lab_orders.in_lab_at, excluded.in_lab_at),
         published_at = coalesce(fact_lab_orders.published_at, excluded.published_at), tat_breached = fact_lab_orders.tat_breached OR excluded.tat_breached,
         abnormal_count = greatest(fact_lab_orders.abnormal_count, excluded.abnormal_count), critical_count = greatest(fact_lab_orders.critical_count, excluded.critical_count),
         event_at = greatest(fact_lab_orders.event_at, excluded.event_at)`,
      [o.id, key, o.branchId, o.status, o.total, o.collectionType ?? null, o.testCount, o.orderedAt, o.collectedAt ?? null, o.inLabAt ?? null, o.publishedAt ?? null, o.tatBreached ?? false, o.abnormalCount ?? 0, o.criticalCount ?? 0, eventAt]);
  }

  async payment(c: Queryable, p: PaymentFact) {
    await c.query(
      `INSERT INTO fact_payments (id, kind, invoice_id, source_type, source_id, branch_id, amount, channel, method, at, local_date)
       VALUES ($1,$2,$3,$4,$5::uuid,
               coalesce($6::uuid, (SELECT branch_id FROM fact_appointments WHERE appointment_id = $5::uuid), (SELECT branch_id FROM fact_lab_orders WHERE order_id = $5::uuid)),
               $7,$8,$9,$10, ${LOCAL('$10', 'coalesce($6::uuid, (SELECT branch_id FROM fact_appointments WHERE appointment_id = $5::uuid))')}::date)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.kind, p.invoiceId, p.sourceType, p.sourceId, p.branchId, p.kind === 'REFUND' ? -Math.abs(p.amount) : p.amount, p.channel, p.method, p.at]);
  }

  async patient(c: Queryable, p: PatientFact) {
    const key = await this.patientKey(c, p.patientId);
    await c.query(`INSERT INTO fact_patients (patient_key, registered_at, local_date, age_band, gender) VALUES ($1,$2,($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,$3,$4)
      ON CONFLICT (patient_key) DO NOTHING`, [key, p.registeredAt, ageBand(p.dob, p.registeredAt), p.gender]);
  }

  // ---------- events ----------

  /** Domain event → warehouse rows (inside the consumer's transaction, deduplicated by processed_events). */
  async onEvent(c: Queryable, e: EventEnvelope) {
    const at = e.time;
    switch (e.type) {
      case EventTypes.branchCreated: case EventTypes.branchUpdated: {
        const b = BranchChanged.parse(e.data);
        return this.branch(c, { id: b.branchId, name: b.name, timezone: b.timezone, active: b.active });
      }
      case EventTypes.doctorCreated: case EventTypes.doctorUpdated: {
        const d = DoctorChanged.parse(e.data);
        return this.doctor(c, { id: d.doctorId, name: d.name, specialtyCodes: d.specialtyCodes, branchIds: d.branchIds, status: d.status });
      }
      case EventTypes.appointmentBooked: case EventTypes.appointmentCancelled: case EventTypes.appointmentRescheduled: case EventTypes.appointmentCheckedIn:
      case EventTypes.appointmentStarted: case EventTypes.appointmentCompleted: case EventTypes.appointmentNoShow: case EventTypes.appointmentPendingPayment:
      case EventTypes.appointmentExpired: {
        const a = AppointmentChanged.parse(e.data);
        return this.appointment(c, {
          id: a.appointmentId, patientId: a.patientId, doctorId: a.doctorId, branchId: a.branchId, startsAt: a.startsAt, localDate: a.localDate ?? null,
          status: a.status, mode: a.mode, source: a.source, bookedVia: a.bookedVia, paymentMode: a.paymentMode, fee: a.fee ?? null, bookedAt: at, rescheduledFrom: a.rescheduledFrom, campaign: a.campaign ?? null,
        }, at);
      }
      case EventTypes.labOrderOrdered: case EventTypes.labOrderPendingPayment: case EventTypes.labOrderBooked: case EventTypes.labOrderCancelled:
      case EventTypes.labOrderExpired: case EventTypes.labOrderCollected: case EventTypes.labOrderInLab: case EventTypes.labOrderSampleRejected:
      case EventTypes.labResultsEntered: case EventTypes.labTatBreached: {
        const o = LabOrderChanged.parse(e.data);
        return this.labOrder(c, {
          id: o.orderId, patientId: o.patientId, branchId: o.branchId, status: o.status, total: o.total, collectionType: o.collectionType ?? null,
          testCount: o.testNames.length, orderedAt: at,
          collectedAt: e.type === EventTypes.labOrderCollected ? at : null, inLabAt: e.type === EventTypes.labOrderInLab ? at : null,
          tatBreached: e.type === EventTypes.labTatBreached,
        }, at);
      }
      case EventTypes.labReportPublished: {
        const r = LabReportPublished.parse(e.data);
        await c.query(`UPDATE fact_lab_orders SET published_at = coalesce(published_at, $2), abnormal_count = $3, critical_count = $4, status = CASE WHEN event_at <= $2 THEN 'REPORT_PUBLISHED' ELSE status END, event_at = greatest(event_at, $2) WHERE order_id = $1`,
          [r.orderId, at, r.abnormalCount, r.criticalCount]);
        return;
      }
      case EventTypes.paymentSucceeded: {
        const p = PaymentSucceeded.parse(e.data);
        return this.payment(c, { id: p.paymentId, kind: 'PAYMENT', invoiceId: p.invoiceId, sourceType: p.sourceType, sourceId: p.sourceId, branchId: p.branchId ?? null, amount: p.amount, channel: p.channel, method: p.method, at });
      }
      case EventTypes.refundProcessed: {
        const r = RefundProcessed.parse(e.data);
        return this.payment(c, { id: r.refundId, kind: 'REFUND', invoiceId: r.invoiceId, sourceType: r.sourceType, sourceId: r.sourceId, branchId: r.branchId ?? null, amount: r.amount, channel: null, method: null, at });
      }
      case EventTypes.patientRegistered: {
        const p = PatientRegistered.parse(e.data);
        return this.patient(c, { patientId: p.patientId, registeredAt: at, dob: p.dob, gender: p.gender });
      }
      case EventTypes.paymentUnapplied: case EventTypes.labPaymentUnapplied: {
        const d = e.data as { appointmentId?: string; orderId?: string; paymentId?: string };
        const branch = d.appointmentId
          ? (await c.query('SELECT branch_id FROM fact_appointments WHERE appointment_id = $1', [d.appointmentId])).rows[0]?.branch_id
          : d.orderId ? (await c.query('SELECT branch_id FROM fact_lab_orders WHERE order_id = $1', [d.orderId])).rows[0]?.branch_id : null;
        await c.query(`INSERT INTO fact_payment_issues (id, kind, branch_id, at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [e.id, e.type, branch ?? null, at]);
        return;
      }
    }
  }
}

/** The event types the warehouse reads. */
export const WAREHOUSE_EVENTS = [
  EventTypes.branchCreated, EventTypes.branchUpdated, EventTypes.doctorCreated, EventTypes.doctorUpdated,
  EventTypes.appointmentBooked, EventTypes.appointmentCancelled, EventTypes.appointmentRescheduled, EventTypes.appointmentCheckedIn,
  EventTypes.appointmentStarted, EventTypes.appointmentCompleted, EventTypes.appointmentNoShow, EventTypes.appointmentPendingPayment, EventTypes.appointmentExpired,
  EventTypes.labOrderOrdered, EventTypes.labOrderPendingPayment, EventTypes.labOrderBooked, EventTypes.labOrderCancelled, EventTypes.labOrderExpired,
  EventTypes.labOrderCollected, EventTypes.labOrderInLab, EventTypes.labOrderSampleRejected, EventTypes.labResultsEntered, EventTypes.labTatBreached,
  EventTypes.labReportPublished, EventTypes.paymentSucceeded, EventTypes.refundProcessed, EventTypes.patientRegistered,
  EventTypes.paymentUnapplied, EventTypes.labPaymentUnapplied,
];
