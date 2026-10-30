import { Injectable } from '@nestjs/common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { type AppointmentChanged, type BillingNotice, type DoctorAgenda, type HomeVisitChanged, type LabCriticalEscalated, type LabCriticalValue, type LabOrderChanged, type LabReportPublished, type PaymentSucceeded, type PrescriptionIssued, type RefundProcessed, EventTypes, type PatientRegistered, type TenantPlacement, type WaitlistSlotAvailable } from '@mc/contracts';
import { type Queryable, TenantContext } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TEMPLATES } from './templates.js';

/** Events older than this (consumer lag, replay) don't trigger "right now" messages; future reminders still get planned. */
const STALE_AFTER_MS = Number(process.env.NOTIFY_STALE_AFTER_MS ?? 3_600_000);
const REMINDERS = [{ key: 'reminder_24h', before: 24 * 3600_000 }, { key: 'reminder_2h', before: 2 * 3600_000 }];
const MIN_LEAD_MS = 5 * 60_000;

const fmt = (date: string, time?: string) => {
  const d = new Date(`${date}T${time ?? '00:00'}:00Z`);
  const day = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
  const t = time ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' }).format(d).toUpperCase() : '';
  return { day, time: t, when: time ? `${day}, ${t}` : day };
};

export function webLink(t: Pick<TenantPlacement, 'hosts'>, path: string) {
  const tpl = process.env.PUBLIC_WEB_URL ?? `http://{host}:${process.env.WEB_PORT ?? '3400'}`;
  return tpl.replace('{host}', t.hosts[0]) + path;
}

/** Turns domain events into rows in the delivery log (immediate messages + scheduled reminders). Idempotent via dedupe keys. */
@Injectable()
export class PlannerService {
  constructor(private readonly entitlements: EntitlementsClient) {}

  async seedTemplates(c: Queryable) {
    for (const t of DEFAULT_TEMPLATES) {
      await c.query('INSERT INTO templates (id, key, channel, language, subject, body) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key, channel, language) DO NOTHING',
        [randomUUID(), t.key, t.channel, t.language, t.subject ?? null, t.body]);
    }
  }

  async onPatient(c: Queryable, p: PatientRegistered) {
    await c.query(`INSERT INTO recipients (patient_id, account_person_id, name) VALUES ($1,$2,$3) ON CONFLICT (patient_id) DO UPDATE SET name = $3`,
      [p.patientId, p.accountPersonId, p.name]);
    if (p.guardianId === null) {
      // contact details come from the account holder's own record; preferences are left untouched
      await c.query(`INSERT INTO contacts (person_id, phone, email) VALUES ($1,$2,$3)
        ON CONFLICT (person_id) DO UPDATE SET phone = coalesce($2, contacts.phone), email = $3, updated_at = now()`, [p.accountPersonId, p.phone, p.email]);
    }
  }

  async onAppointment(c: Queryable, type: string, a: AppointmentChanged, eventTime: string) {
    const t = TenantContext.require();
    const f = fmt(a.localDate ?? a.startsAt.slice(0, 10), a.localTime);
    const vars = {
      hospital: t.name, appointmentNo: a.appointmentNo, patientName: a.patientName ?? '', doctorName: a.doctorName ?? 'your doctor',
      when: f.when, date: f.day, time: f.time, where: a.mode === 'VIDEO' ? 'video call' : a.branchName ?? '', fee: !a.fee ? '' : a.paymentStatus === 'PAID' ? `₹${a.fee}, paid online` : `₹${a.fee}, pay at the hospital`,
      link: webLink(t, type === EventTypes.appointmentCancelled ? '/care/doctors' : '/care/appointments'),
      // the hospital's own cancel cutoff (review F-3)
      cutoff: await this.entitlements.setting(t.id, 'appointments.cancel_cutoff_hours', 2).then((h) => `${h} hour${Number(h) === 1 ? '' : 's'}`).catch(() => '2 hours'),
    };
    const fresh = Date.now() - Date.parse(eventTime) < STALE_AFTER_MS;
    const now = new Date();

    if (type === EventTypes.appointmentBooked || type === EventTypes.appointmentRescheduled) {
      if (a.rescheduledFrom) await this.cancelPending(c, a.rescheduledFrom);
      if (fresh) await this.plan(c, type === EventTypes.appointmentBooked ? 'appointment_confirmed' : 'appointment_rescheduled', a.accountPersonId, vars, a.appointmentId, now);
      for (const r of REMINDERS) {
        const at = new Date(Date.parse(a.startsAt) - r.before);
        if (at.getTime() > Date.now() + MIN_LEAD_MS) await this.plan(c, r.key, a.accountPersonId, vars, a.appointmentId, at);
      }
    } else if (type === EventTypes.appointmentCancelled) {
      await this.cancelPending(c, a.appointmentId);
      const key = a.reason === 'DOCTOR_UNAVAILABLE' ? 'appointment_cancelled_doctor' : 'appointment_cancelled';
      if (fresh && Date.parse(a.startsAt) > Date.now()) await this.plan(c, key, a.accountPersonId, vars, a.appointmentId, now);
    } else if (type === EventTypes.appointmentExpired) {
      // the online payment was not completed in time: the patient is told the time was released (4.G)
      await this.cancelPending(c, a.appointmentId);
      if (fresh) await this.plan(c, 'appointment_expired', a.accountPersonId, { ...vars, link: webLink(t, '/care/doctors') }, a.appointmentId, now, `${a.appointmentId}:expired`);
    }
    // the doctor hears about bookings and cancellations for today (walk-ins appear in the queue anyway), 4.G
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
    if (fresh && a.doctorUserId && a.localDate === today && a.source !== 'WALK_IN' && Date.parse(a.startsAt) > Date.now()
      && (type === EventTypes.appointmentBooked || type === EventTypes.appointmentCancelled)) {
      const change = type === EventTypes.appointmentBooked ? 'New booking' : 'Cancelled';
      await this.plan(c, 'doctor_day_change', a.doctorUserId, { ...vars, change, link: webLink(t, '/doctor/queue') }, a.appointmentId, now, `${a.appointmentId}:${type}:doctor`, 'staff');
    }
  }

  /** The doctor's list for the day (scheduling AgendaJob), e-mailed in the morning. */
  async onDoctorAgenda(c: Queryable, d: DoctorAgenda) {
    const t = TenantContext.require();
    const list = d.items.map((i) => `${fmt(d.date, i.time).time}  ${i.patientName}  (${i.mode === 'VIDEO' ? 'video' : i.branchName}, ${i.appointmentNo})`).join('\n');
    await this.plan(c, 'doctor_agenda', d.doctorUserId, { hospital: t.name, doctorName: d.doctorName, date: fmt(d.date).day, count: d.items.length, list, link: webLink(t, '/doctor/queue') }, d.doctorId, new Date(), `${d.doctorId}:${d.date}`, 'staff');
  }

  /** A lab order past its promised report time: the lab at that branch (people who enter results). */
  async onTatBreached(c: Queryable, o: LabOrderChanged) {
    const t = TenantContext.require();
    const q = o.branchId ? `?branchId=${o.branchId}` : '';
    const res = await fetch(`${process.env.SVC_URL_ENTITLEMENT ?? 'http://localhost:4403'}/internal/tenants/${t.id}/users-with-permission/result:enter:branch${q}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' } });
    if (!res.ok) throw new Error(`entitlement-service ${res.status}`);
    const { userIds } = (await res.json()) as { userIds: string[] };
    const vars = { hospital: t.name, orderNo: o.orderNo, tests: o.testNames.slice(0, 4).join(', '), link: webLink(t, '/lab/pending') };
    for (const u of userIds) await this.plan(c, 'lab_tat_breached', u, vars, o.orderId, new Date(), `${o.orderId}:tat:${u}`, 'staff');
  }

  /** billing.payment_succeeded → receipt; billing.refund_processed → "refund on its way". Not stale-sensitive: money. */
  async onPayment(c: Queryable, p: PaymentSucceeded) {
    const t = TenantContext.require();
    const vars = { hospital: t.name, amount: `₹${p.amount}`, invoiceNo: p.invoiceNo, patientName: p.patientName, method: p.channel === 'ONLINE' ? `online${p.method ? `, ${p.method.toUpperCase()}` : ''}` : `at the counter, ${p.method ?? ''}`, link: webLink(t, '/care/bills') };
    await this.plan(c, 'payment_received', p.accountPersonId, vars, p.invoiceId, new Date(), `${p.invoiceId}:${p.paymentId}`);
  }

  async onRefund(c: Queryable, r: RefundProcessed) {
    const t = TenantContext.require();
    const vars = { hospital: t.name, amount: `₹${r.amount}`, invoiceNo: r.invoiceNo, patientName: r.patientName, reason: r.reason ?? 'refund', link: webLink(t, '/care/bills') };
    await this.plan(c, 'refund_initiated', r.accountPersonId, vars, r.invoiceId, new Date(), `${r.invoiceId}:${r.refundId}`);
  }

  /** records.prescription_issued → "your prescription is ready" (a link; never drug names in a message). */
  /**
   * MediCare billing notices (subscription.billing_notice) → an e-mail to every account owner of the hospital (staff
   * holding subscription:manage:tenant, looked up in entitlement-service). Never to patients.
   */
  async onBillingNotice(c: Queryable, n: BillingNotice) {
    const t = TenantContext.require();
    const res = await fetch(`${process.env.SVC_URL_ENTITLEMENT ?? 'http://localhost:4403'}/internal/tenants/${t.id}/users-with-permission/subscription:manage:tenant`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' } });
    if (!res.ok) throw new Error(`entitlement-service ${res.status}`);
    const { userIds } = (await res.json()) as { userIds: string[] };
    const { subject, message } = billingWording(n, t.name);
    for (const userId of userIds) {
      await this.plan(c, 'billing_notice_staff', userId, { subject, message, link: webLink(t, '/account') }, randomUUID(), new Date(), `${n.dedupe}:${userId}`, 'staff');
    }
  }

  async onPrescription(c: Queryable, p: PrescriptionIssued) {
    const t = TenantContext.require();
    const vars = { hospital: t.name, prescriptionNo: p.prescriptionNo, doctorName: p.doctorName, patientName: p.patientName, link: webLink(t, '/care/prescriptions') };
    await this.plan(c, 'prescription_ready', p.accountPersonId, vars, p.prescriptionId, new Date());
    // the doctor asked to see the patient again: a reminder the day before, 9 AM India time (4.G)
    if (p.followUpOn) {
      const at = new Date(Date.parse(`${p.followUpOn}T03:30:00Z`) - 86_400_000);
      if (at.getTime() > Date.now() + MIN_LEAD_MS) {
        await this.plan(c, 'follow_up_reminder', p.accountPersonId, { ...vars, date: fmt(p.followUpOn).day, link: webLink(t, `/care/doctors/${p.doctorId}`) }, p.prescriptionId, at, `${p.prescriptionId}:follow-up`);
      }
    }
  }

  /** Lab orders: booked (with preparation, never test names), doctor-requested (book a time), sample to repeat. */
  async onLabOrder(c: Queryable, type: string, o: LabOrderChanged, eventTime: string) {
    if (Date.now() - Date.parse(eventTime) > STALE_AFTER_MS) return;
    const t = TenantContext.require();
    const f = o.localDate ? fmt(o.localDate, o.localTime ?? undefined) : null;
    const vars = {
      hospital: t.name, patientName: o.patientName, orderNo: o.orderNo, when: f?.when ?? '', where: o.collectionType === 'HOME' ? 'home (sample collection)' : o.branchName ?? 'the lab',
      prep: o.preparation ? `${o.preparation}.` : 'No special preparation needed.', doctorName: o.orderedByName ?? 'Your doctor', link: webLink(t, '/care/lab-orders'),
    };
    if (type === EventTypes.labOrderCancelled || type === EventTypes.labOrderExpired) await this.cancelPending(c, o.orderId);
    const refundLine = o.refundPercent ? `${o.refundPercent === 100 ? 'The full amount' : `${o.refundPercent}% of what was paid`} will be refunded.` : '';
    const key = type === EventTypes.labOrderBooked ? 'lab_booked' : type === EventTypes.labOrderOrdered ? 'lab_ordered' : type === EventTypes.labOrderSampleRejected ? 'lab_recollect'
      : type === EventTypes.labOrderCancelled ? 'lab_cancelled' : type === EventTypes.labOrderExpired ? 'lab_expired' : null;
    if (key) await this.plan(c, key, o.accountPersonId, { ...vars, refundLine }, o.orderId, new Date(), `${o.orderId}:${type}:${o.status}`);
    // preparation (fasting…) reminder 12 hours before a booked visit (HLD promise, 4.G); a new time replaces it
    if (type === EventTypes.labOrderBooked && o.preparation && o.slotAt) {
      const at = new Date(Date.parse(o.slotAt) - 12 * 3_600_000);
      if (at.getTime() > Date.now() + MIN_LEAD_MS) {
        await c.query(`UPDATE notifications SET status = 'CANCELLED', last_error = 'new lab time' WHERE related_id = $1 AND template_key = 'lab_prep_reminder' AND status = 'SCHEDULED'`, [o.orderId]);
        await this.plan(c, 'lab_prep_reminder', o.accountPersonId, vars, o.orderId, at, `${o.orderId}:prep:${o.slotAt}`);
      }
    }
  }

  /** Home collection: who is coming and when, on the way, missed (patient); a new visit (the phlebotomist, email). */
  async onHomeVisit(c: Queryable, type: string, v: HomeVisitChanged, eventTime: string) {
    if (Date.now() - Date.parse(eventTime) > STALE_AFTER_MS) return;
    const t = TenantContext.require();
    const f = fmt(v.localDate, v.localTime);
    const vars = { hospital: t.name, patientName: v.patientName, orderNo: v.orderNo, when: f.when, collector: v.phlebotomistName ?? 'Our sample collector', pincode: v.pincode, link: webLink(t, '/care/lab-orders') };
    const key = type === EventTypes.homeVisitAssigned ? 'home_visit_assigned' : type === EventTypes.homeVisitEnRoute ? 'home_visit_en_route' : type === EventTypes.homeVisitMissed ? 'home_visit_missed' : null;
    if (key) await this.plan(c, key, v.accountPersonId, vars, v.visitId, new Date(), `${v.visitId}:${type}:${v.slotAt}:${v.phlebotomistUserId ?? ''}`);
    if (type === EventTypes.homeVisitAssigned && v.phlebotomistUserId) {
      await this.plan(c, 'home_visit_assigned_staff', v.phlebotomistUserId, { ...vars, link: webLink(t, '/lab/visits') }, v.visitId, new Date(), `${v.visitId}:staff:${v.slotAt}:${v.phlebotomistUserId}`, 'staff');
    }
  }

  /** Report verified: the patient (SMS/email, no values) and the ordering doctor (email). */
  async onLabReport(c: Queryable, r: LabReportPublished) {
    const t = TenantContext.require();
    const vars = {
      hospital: t.name, patientName: r.patientName, patientMrn: r.patientMrn, orderNo: r.orderNo, amendedNote: r.amended ? ' (updated)' : '',
      flagsLine: r.criticalCount ? `${r.criticalCount} critical and ${r.abnormalCount} abnormal value(s).` : r.abnormalCount ? `${r.abnormalCount} value(s) outside the reference range.` : 'All values within the reference ranges.',
      link: webLink(t, '/care/lab-orders'),
    };
    await this.plan(c, 'lab_report_ready', r.accountPersonId, vars, r.reportId, new Date(), `${r.reportId}`);
    if (r.orderedByUserId) await this.plan(c, 'lab_report_ready_doctor', r.orderedByUserId, { ...vars, link: webLink(t, '/doctor/lab-results') }, r.reportId, new Date(), `${r.reportId}:doctor`, 'staff');
  }

  /** Critical value: email the ordering doctor at once (the value itself stays in the app). */
  async onCriticalValue(c: Queryable, a: LabCriticalValue) {
    if (!a.orderedByUserId) return; // self-booked: the pathologist sees it in the lab zone
    const t = TenantContext.require();
    await this.plan(c, 'lab_critical_value', a.orderedByUserId, { hospital: t.name, patientName: a.patientName, patientMrn: a.patientMrn, orderNo: a.orderNo, testName: a.testName, parameter: a.parameter, link: webLink(t, '/doctor/lab-results') }, a.alertId, new Date(), a.alertId, 'staff');
  }

  /**
   * Nobody acknowledged a critical value (review C-2): level 1 → the branch's pathologists, level 2 → on call at the
   * branch (critical:escalation:branch, the branch admin by default). E-mail (staff have no SMS channel).
   */
  async onCriticalEscalated(c: Queryable, a: LabCriticalEscalated) {
    const t = TenantContext.require();
    const permission = a.level === 1 ? 'report:verify:branch' : 'critical:escalation:branch';
    const q = a.branchId ? `?branchId=${a.branchId}` : '';
    const res = await fetch(`${process.env.SVC_URL_ENTITLEMENT ?? 'http://localhost:4403'}/internal/tenants/${t.id}/users-with-permission/${permission}${q}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' } });
    if (!res.ok) throw new Error(`entitlement-service ${res.status}`);
    const { userIds } = (await res.json()) as { userIds: string[] };
    const vars = {
      hospital: t.name, patientName: a.patientName, patientMrn: a.patientMrn, orderNo: a.orderNo, testName: a.testName, parameter: a.parameter, minutesOpen: a.minutesOpen,
      orderedByLine: a.orderedByName ? `Ordered by ${a.orderedByName}, who has not acknowledged it.` : 'Booked by the patient: no doctor has been told.',
      action: a.level === 1 ? 'Phone the value through to the doctor (or the duty doctor), have it read back, and record it in the lab.' : 'The lab has not been able to hand this over: make sure a doctor is reached now.',
      link: webLink(t, '/lab/critical'),
    };
    for (const userId of userIds) await this.plan(c, 'lab_critical_escalated', userId, vars, a.alertId, new Date(), `${a.alertId}:${a.level}:${userId}`, 'staff');
  }

  async onWaitlist(c: Queryable, w: WaitlistSlotAvailable & { doctorName?: string }, eventTime: string) {
    if (Date.now() - Date.parse(eventTime) > STALE_AFTER_MS) return;
    const t = TenantContext.require();
    const { rows } = await c.query('SELECT name FROM recipients WHERE patient_id = $1', [w.patientId]);
    const vars = { hospital: t.name, patientName: rows[0]?.name ?? '', doctorName: w.doctorName ?? 'your doctor', date: fmt(w.date).day, link: webLink(t, `/care/doctors/${w.doctorId}?date=${w.date}#book`) };
    await this.plan(c, 'waitlist_slot_available', w.accountPersonId, vars, w.waitlistId, new Date(), `${w.waitlistId}:${w.slotId}`);
  }

  /** One row per channel that has a template for this key. */
  private async plan(c: Queryable, key: string, personId: string, vars: Record<string, unknown>, relatedId: string, sendAt: Date, dedupeSuffix = relatedId, recipientKind: 'patient' | 'staff' = 'patient') {
    const { rows } = await c.query('SELECT DISTINCT channel FROM templates WHERE key = $1 AND active', [key]);
    for (const { channel } of rows) {
      if (recipientKind === 'staff' && channel !== 'EMAIL') continue; // staff: email only
      await c.query(
        `INSERT INTO notifications (id, dedupe_key, recipient_person_id, channel, template_key, vars, related_type, related_id, status, send_at, recipient_kind)
         VALUES ($1,$2,$3,$4,$5,$6,'APPOINTMENT',$7,'SCHEDULED',$8,$9) ON CONFLICT (dedupe_key) DO NOTHING`,
        [randomUUID(), `${key}:${channel}:${dedupeSuffix}`, personId, channel, key, JSON.stringify(vars), relatedId, sendAt, recipientKind],
      );
    }
  }

  async cancelPending(c: Queryable, relatedId: string) {
    await c.query(`UPDATE notifications SET status = 'CANCELLED', last_error = 'appointment changed' WHERE related_id = $1 AND status = 'SCHEDULED'`, [relatedId]);
  }
}

const inr = (n: number | null) => (n == null ? '' : `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`);
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
const FEATURE_NAMES: Record<string, string> = { 'core.sms': 'SMS messages' };

/** What MediCare tells the hospital's account owner, per notice. */
export function billingWording(n: BillingNotice, hospital: string): { subject: string; message: string } {
  const f = FEATURE_NAMES[n.feature ?? ''] ?? n.feature ?? '';
  switch (n.kind) {
    case 'TRIAL_ENDING': return { subject: `Your MediCare trial ends on ${day(n.date)}`, message: `The MediCare trial for ${hospital} ends on ${day(n.date)}. Add a card before then to keep everything working; nothing is charged until the trial ends.` };
    case 'TRIAL_CONVERTED': return { subject: 'Your MediCare subscription has started', message: `Thank you: the trial for ${hospital} is now a paid subscription. Invoice ${n.invoiceNo}: ${inr(n.amount)} (GST included).` };
    case 'PAYMENT_FAILED': return { subject: `Payment failed for invoice ${n.invoiceNo}`, message: `We could not charge your card for invoice ${n.invoiceNo} (${inr(n.amount)}). We will try again on ${day(n.date)}. You can pay now or use another card.` };
    case 'GRACE_STARTED': return { subject: 'MediCare payment overdue: action needed', message: `Payment for ${hospital}'s MediCare subscription is overdue. Everything keeps working until ${day(n.date)}; after that the hospital becomes read-only (records can be viewed, nothing new can be booked or added) until the invoices are paid.` };
    case 'SUSPENDED': return { subject: 'MediCare subscription suspended', message: `${hospital}'s MediCare subscription is suspended because invoices are unpaid. Patients and staff can still view records; nothing new can be booked or added. Pay the open invoices to restore everything at once.` };
    case 'PAYMENT_RECEIVED': return { subject: 'Payment received: subscription active', message: `Thank you: we received ${inr(n.amount)}. ${hospital}'s MediCare subscription is active again.` };
    case 'USAGE_80': return { subject: `80% of this month's ${f} used`, message: `${hospital} has used ${n.used} of the ${n.limit} ${f} included this month.` };
    case 'USAGE_100': return { subject: `This month's ${f} allowance is used up`, message: `${hospital} has used all ${n.limit} ${f} included this month (${n.used} so far). Depending on your plan, further ones are billed on the next invoice or held until next month.` };
  }
}
