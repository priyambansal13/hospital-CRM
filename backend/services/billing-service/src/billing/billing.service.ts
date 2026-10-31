import { PaymentAccountService } from './payment-account.service.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type AppointmentChanged, EventTypes, type LabOrderChanged, type PaymentSucceeded, type RefundProcessed, Topics } from '@mc/contracts';
import { conflict, CONTROL_DB, DomainError, notFound } from '@mc/nest-common';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { type GatewayPayment, PAYMENT_GATEWAY, type PaymentGateway, toPaise, toRupees } from '../gateway/gateway.js';

export interface OnlineInvoiceInput {
  sourceType: 'APPOINTMENT' | 'LAB_ORDER' | 'MEMBERSHIP'; sourceId: string; patientId: string; patientName: string; patientMrn: string; accountPersonId: string;
  /** null only for memberships (not tied to a branch) */
  branchId: string | null; branchName: string | null; description: string; amount: number; expiresAt: string;
}

const money = (v: unknown) => Number(v ?? 0);
export const toInvoice = (r: any) => ({
  id: r.id, invoiceNo: r.invoice_no, status: r.status, paymentMode: r.payment_mode,
  source: { type: r.source_type, id: r.source_id }, patient: { id: r.patient_id, name: r.patient_name, mrn: r.patient_mrn },
  branch: { id: r.branch_id, name: r.branch_name ?? (r.source_type === 'MEMBERSHIP' ? 'Membership' : null) }, description: r.description,
  subtotal: money(r.subtotal), discount: money(r.discount), tax: money(r.tax), total: money(r.total), currency: r.currency,
  amountPaid: money(r.amount_paid), amountRefunded: money(r.amount_refunded),
  payBy: r.pay_by, issuedAt: r.issued_at, paidAt: r.paid_at, voidedAt: r.voided_at, voidReason: r.void_reason,
});
export type InvoiceDto = ReturnType<typeof toInvoice>;

/**
 * Invoices, payments and refunds (docs/LLD.md §3.7, §5.3–5.5). Rules:
 *  - never hold a DB transaction across a gateway call (orders, payment lookups and refunds happen outside);
 *  - every state change writes its event to the outbox in the same transaction;
 *  - webhooks and checkout callbacks can arrive in any order and more than once: capture/refund are idempotent.
 */
@Injectable()
export class BillingService {
  private readonly log = new Logger('Billing');

  constructor(
    private readonly db: TenantDbRouter,
    @Inject(CONTROL_DB) private readonly control: pg.Pool,
    @Inject(PAYMENT_GATEWAY) readonly gateway: PaymentGateway,
    private readonly accounts: PaymentAccountService,
  ) {}

  async invoice(c: Queryable, id: string, lock = false) {
    const { rows } = await c.query(`SELECT * FROM invoices WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0];
  }

  /** Owner (patient account) or staff with invoice:read:branch; anyone else 404. */
  /** `staffAt(branchId)`: may this staff member see the branch's invoices (review B-1)? */
  async assertCanSee(c: Queryable, actor: Actor, id: string, staffAt: (branchId: string) => boolean) {
    const r = await this.invoice(c, id);
    if (!r) throw notFound('invoice');
    if (actor.kind === 'patient' ? r.account_person_id !== actor.id : !staffAt(r.branch_id)) throw notFound('invoice');
    return r;
  }

  async detail(c: Queryable, r: any) {
    const [{ rows: payments }, { rows: refunds }] = await Promise.all([
      c.query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at', [r.id]),
      c.query('SELECT * FROM refunds WHERE invoice_id = $1 ORDER BY created_at', [r.id]),
    ]);
    const open = payments.find((p) => p.channel === 'ONLINE' && p.status === 'CREATED');
    return {
      ...toInvoice(r),
      payments: payments.map((p) => ({ id: p.id, channel: p.channel, gateway: p.gateway, amount: money(p.amount), method: p.method, reference: p.reference, status: p.status, lastError: p.last_error, gatewayPaymentId: p.gateway_payment_id, createdAt: p.created_at, capturedAt: p.captured_at })),
      refunds: refunds.map((x) => ({ id: x.id, amount: money(x.amount), reason: x.reason, status: x.status, gatewayRefundId: x.gateway_refund_id, createdAt: x.created_at, processedAt: x.processed_at })),
      // what the browser needs to open the gateway's checkout (only while payable online)
      checkout: r.status === 'ISSUED' && open ? { gateway: this.gateway.name, keyId: this.gateway.keyId, orderId: open.gateway_order_id, amount: money(r.total), currency: r.currency } : null,
    };
  }

  // ---------- opening invoices ----------

  /** Online booking: invoice + gateway order. Idempotent per source (a retry returns the same order). */
  async openOnline(input: OnlineInvoiceInput) {
    const tenant = TenantContext.require();
    const pool = await this.db.current();
    const { rows: existing } = await pool.query(`SELECT * FROM invoices WHERE source_type = $1 AND source_id = $2`, [input.sourceType, input.sourceId]);
    if (existing[0]) {
      if (existing[0].status !== 'ISSUED') throw conflict('INVOICE_NOT_PAYABLE', `invoice ${existing[0].invoice_no} is ${existing[0].status.toLowerCase()}`);
      return this.checkoutFor(pool, existing[0]);
    }
    await this.accounts.assertReady(pool); // no linked account: patients pay at the hospital
    const id = randomUUID();
    const order = await this.gateway.createOrder({ amount: toPaise(input.amount), receipt: id.replaceAll('-', '').slice(0, 32), notes: { tenantId: tenant.id, invoiceId: id, sourceId: input.sourceId } });
    await this.control.query(`INSERT INTO gateway_refs (ref, kind, tenant_id) VALUES ($1, 'ORDER', $2) ON CONFLICT DO NOTHING`, [order.id, tenant.id]);
    const inv = await this.db.tx(async (c) => {
      const r = await this.insertInvoice(c, id, { ...input, paymentMode: 'ONLINE', payBy: input.expiresAt });
      await c.query(`INSERT INTO payments (id, invoice_id, channel, gateway, gateway_order_id, amount, status) VALUES ($1,$2,'ONLINE',$3,$4,$5,'CREATED')`,
        [randomUUID(), id, this.gateway.name, order.id, input.amount]);
      return r;
    });
    return this.checkoutFor(pool, inv);
  }

  private async checkoutFor(c: Queryable, r: any) {
    const { rows } = await c.query(`SELECT gateway_order_id FROM payments WHERE invoice_id = $1 AND channel = 'ONLINE' AND status = 'CREATED' ORDER BY created_at DESC LIMIT 1`, [r.id]);
    if (!rows[0]) throw conflict('INVOICE_NOT_PAYABLE', 'no open payment order for this invoice');
    return { invoiceId: r.id, invoiceNo: r.invoice_no, amount: money(r.total), currency: r.currency, gateway: this.gateway.name, orderId: rows[0].gateway_order_id, keyId: this.gateway.keyId, payBy: r.pay_by };
  }

  private async insertInvoice(c: Queryable, id: string, v: Omit<OnlineInvoiceInput, 'expiresAt'> & { paymentMode: 'ONLINE' | 'AT_CLINIC'; payBy: string | null }) {
    const { rows } = await c.query(
      `INSERT INTO invoices (id, invoice_no, source_type, source_id, patient_id, patient_name, patient_mrn, account_person_id, branch_id, branch_name, description, subtotal, total, payment_mode, status, pay_by)
       VALUES ($1, 'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_seq')::text, 6, '0'), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,'ISSUED',$13) RETURNING *`,
      [id, v.sourceType, v.sourceId, v.patientId, v.patientName, v.patientMrn, v.accountPersonId, v.branchId, v.branchName, v.description, v.amount, v.paymentMode, v.payBy]);
    return rows[0];
  }

  /** Pay-at-clinic (and front-desk) bookings: an invoice to settle at the counter. Idempotent per appointment. */
  async onAppointmentBooked(c: Queryable, a: AppointmentChanged) {
    if (a.paymentMode === 'ONLINE' || !a.fee || a.fee <= 0) return;
    const { rows } = await c.query(`SELECT 1 FROM invoices WHERE source_type = 'APPOINTMENT' AND source_id = $1`, [a.appointmentId]);
    if (rows[0]) return;
    await this.insertInvoice(c, randomUUID(), {
      sourceType: 'APPOINTMENT', sourceId: a.appointmentId, patientId: a.patientId, patientName: a.patientName ?? 'Patient', patientMrn: a.patientMrn ?? '',
      accountPersonId: a.accountPersonId, branchId: a.branchId, branchName: a.branchName ?? '', amount: a.fee,
      description: `Consultation with ${a.doctorName ?? 'doctor'}, ${a.localDate ?? ''} ${a.localTime ?? ''} (${a.appointmentNo})`.replace(/\s+/g, ' '),
      paymentMode: 'AT_CLINIC', payBy: null,
    });
  }

  /** The appointment moved: the invoice (and any payment) follows the new appointment id. */
  async onAppointmentRescheduled(c: Queryable, a: AppointmentChanged) {
    if (!a.rescheduledFrom) return;
    await c.query(`UPDATE invoices SET source_id = $2, description = regexp_replace(description, '\\(APT-[0-9-]+\\)$', $3), version = version + 1, updated_at = now()
                   WHERE source_type = 'APPOINTMENT' AND source_id = $1`, [a.rescheduledFrom, a.appointmentId, `(${a.appointmentNo})`]);
  }

  /** Cancelled: unpaid → void; paid → refund the policy's share (decided by scheduling, sent on the event). */
  async onAppointmentCancelled(c: Queryable, a: AppointmentChanged) {
    return this.onSourceCancelled(c, 'APPOINTMENT', a.appointmentId, a.refundPercent ?? null, 'Appointment cancelled');
  }

  async onAppointmentExpired(c: Queryable, a: AppointmentChanged) {
    return this.onSourceExpired(c, 'APPOINTMENT', a.appointmentId);
  }

  async onSourceCancelled(c: Queryable, sourceType: 'APPOINTMENT' | 'LAB_ORDER', sourceId: string, refundPercent: number | null, label: string) {
    const { rows } = await c.query(`SELECT * FROM invoices WHERE source_type = $1 AND source_id = $2 FOR UPDATE`, [sourceType, sourceId]);
    const inv = rows[0];
    if (!inv) return;
    if (inv.status === 'ISSUED') return this.void(c, inv, `${sourceType}_CANCELLED`);
    if (['PAID', 'PARTIALLY_REFUNDED'].includes(inv.status) && refundPercent) {
      const amount = Math.round(money(inv.amount_paid) * refundPercent) / 100;
      await this.requestRefund(c, inv, amount, `${label} (${refundPercent}% refund)`, `cancel:${sourceId}`, null, undefined, { capToRefundable: true });
    }
  }

  async onSourceExpired(c: Queryable, sourceType: 'APPOINTMENT' | 'LAB_ORDER', sourceId: string) {
    const { rows } = await c.query(`SELECT * FROM invoices WHERE source_type = $1 AND source_id = $2 FOR UPDATE`, [sourceType, sourceId]);
    if (rows[0]?.status === 'ISSUED') await this.void(c, rows[0], 'PAYMENT_NOT_COMPLETED');
  }

  /** Lab tests to pay at the lab: an invoice to settle at the counter. Idempotent per order. */
  async onLabOrderBooked(c: Queryable, o: LabOrderChanged) {
    if (o.paymentMode !== 'AT_CLINIC' || o.total <= 0 || !o.branchId) return;
    const { rows } = await c.query(`SELECT 1 FROM invoices WHERE source_type = 'LAB_ORDER' AND source_id = $1`, [o.orderId]);
    if (rows[0]) return;
    await this.insertInvoice(c, randomUUID(), {
      sourceType: 'LAB_ORDER', sourceId: o.orderId, patientId: o.patientId, patientName: o.patientName, patientMrn: o.patientMrn,
      accountPersonId: o.accountPersonId, branchId: o.branchId, branchName: o.branchName ?? '', amount: o.total,
      description: `Lab tests ${o.orderNo}: ${o.testNames.join(', ')}`.slice(0, 290), paymentMode: 'AT_CLINIC', payBy: null,
    });
  }

  /** Scheduling could not use a payment (slot lost / cancelled meanwhile): give it all back. */
  async onPaymentUnapplied(c: Queryable, u: { appointmentId: string; invoiceId: string; paymentId: string; reason: string }) {
    const inv = await this.invoice(c, u.invoiceId, true);
    if (!inv) return;
    const remaining = money(inv.amount_paid) - money(inv.amount_refunded);
    if (remaining > 0) await this.requestRefund(c, inv, remaining, u.reason === 'SLOT_LOST' ? 'Payment arrived after the time was given to someone else' : 'Appointment was cancelled before the payment arrived', `unapplied:${u.appointmentId}`, null, undefined, { capToRefundable: true });
  }

  private async void(c: Queryable, inv: any, reason: string) {
    await c.query(`UPDATE invoices SET status = 'VOID', voided_at = now(), void_reason = $2, version = version + 1, updated_at = now() WHERE id = $1 AND status = 'ISSUED'`, [inv.id, reason]);
    await addToOutbox(c, Topics.billing, inv.id, envelope(EventTypes.invoiceVoided, { invoiceId: inv.id, sourceType: inv.source_type, sourceId: inv.source_id, reason }, { tenantId: TenantContext.require().id, subject: inv.id }));
  }

  // ---------- payments ----------

  /**
   * Record a captured online payment (checkout callback or webhook, whichever is first). Marks the invoice paid
   * (also a voided one: the money is real, and scheduling decides whether the slot can still be had).
   */
  async capture(c: Queryable, orderId: string, gp: GatewayPayment) {
    const { rows } = await c.query(`SELECT * FROM payments WHERE gateway_order_id = $1 FOR UPDATE`, [orderId]);
    const pay = rows[0];
    if (!pay) throw notFound('payment order');
    if (pay.status === 'CAPTURED' && pay.gateway_payment_id === gp.id) return { invoiceId: pay.invoice_id, duplicate: true }; // same payment again
    const inv = await this.invoice(c, pay.invoice_id, true);
    if (pay.status === 'CAPTURED') {
      // a SECOND payment on the same order (checkout retried after a success): record it and send it back
      const { rows: seen } = await c.query('SELECT 1 FROM payments WHERE gateway_payment_id = $1', [gp.id]);
      if (seen[0]) return { invoiceId: inv.id, duplicate: true };
      const extra = randomUUID();
      await c.query(`INSERT INTO payments (id, invoice_id, channel, gateway, gateway_payment_id, amount, method, reference, status, captured_at) VALUES ($1,$2,'ONLINE',$3,$4,$5,$6,$7,'CAPTURED',now())`,
        [extra, inv.id, pay.gateway, gp.id, toRupees(gp.amount), gp.method, `order ${orderId}`]);
      await c.query(`INSERT INTO refunds (id, invoice_id, payment_id, amount, reason, status, dedupe_key) VALUES ($1,$2,$3,$4,'Duplicate payment','PENDING',$5) ON CONFLICT (dedupe_key) DO NOTHING`,
        [randomUUID(), inv.id, extra, toRupees(gp.amount), `duplicate:${gp.id}`]);
      return { invoiceId: inv.id, duplicate: true };
    }
    if (toRupees(gp.amount) < money(inv.total)) throw new DomainError(422, 'AMOUNT_MISMATCH', `paid ${toRupees(gp.amount)}, invoice is ${money(inv.total)}`);
    await c.query(`UPDATE payments SET status = 'CAPTURED', gateway_payment_id = $2, method = $3, amount = $4, captured_at = now(), last_error = NULL WHERE id = $1`,
      [pay.id, gp.id, gp.method, toRupees(gp.amount)]);
    if (inv.status === 'PAID' || inv.status === 'PARTIALLY_REFUNDED' || inv.status === 'REFUNDED') {
      // paid twice (two tabs, retried checkout): the extra payment goes straight back; the invoice is unaffected
      await c.query(`INSERT INTO refunds (id, invoice_id, payment_id, amount, reason, status, dedupe_key) VALUES ($1,$2,$3,$4,'Duplicate payment','PENDING',$5) ON CONFLICT (dedupe_key) DO NOTHING`,
        [randomUUID(), inv.id, pay.id, toRupees(gp.amount), `duplicate:${gp.id}`]);
      return { invoiceId: inv.id, duplicate: true };
    }
    await this.markPaid(c, inv, pay.id, toRupees(gp.amount), gp.method, 'ONLINE');
    return { invoiceId: inv.id, duplicate: false };
  }

  private async markPaid(c: Queryable, inv: any, paymentId: string, amount: number, method: string | null, channel: 'ONLINE' | 'COUNTER') {
    await c.query(`UPDATE invoices SET status = 'PAID', amount_paid = $2, paid_at = now(), voided_at = NULL, void_reason = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [inv.id, amount]);
    const data: PaymentSucceeded = {
      invoiceId: inv.id, invoiceNo: inv.invoice_no, paymentId, sourceType: inv.source_type, sourceId: inv.source_id,
      accountPersonId: inv.account_person_id, patientName: inv.patient_name, amount, method, channel,
    };
    await addToOutbox(c, Topics.billing, inv.id, envelope(EventTypes.paymentSucceeded, data, { tenantId: TenantContext.require().id, subject: inv.id }));
    if (channel === 'ONLINE') await this.accounts.transfer(c, inv.id, paymentId, amount);
  }

  /** Front desk: cash / UPI QR / card machine at the counter. */
  async collectAtCounter(actor: Actor, source: { sourceType: 'APPOINTMENT' | 'LAB_ORDER'; sourceId: string }, method: 'CASH' | 'UPI' | 'CARD', reference: string | null, at: (branchId: string) => boolean = () => true) {
    return this.db.tx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM invoices WHERE source_type = $1 AND source_id = $2 FOR UPDATE`, [source.sourceType, source.sourceId]);
      const inv = rows[0];
      if (!inv || !at(inv.branch_id)) throw notFound('invoice');
      if (inv.status !== 'ISSUED') throw conflict(inv.status === 'VOID' ? 'INVOICE_VOID' : 'ALREADY_PAID', `invoice ${inv.invoice_no} is ${inv.status.toLowerCase().replace('_', ' ')}`);
      if (method !== 'CASH' && !reference) throw new DomainError(422, 'REFERENCE_REQUIRED', `enter the ${method === 'UPI' ? 'UPI transaction' : 'card slip'} reference`);
      const pid = randomUUID();
      await c.query(`INSERT INTO payments (id, invoice_id, channel, gateway, amount, method, reference, status, collected_by, captured_at) VALUES ($1,$2,'COUNTER','COUNTER',$3,$4,$5,'CAPTURED',$6,now())`,
        [pid, inv.id, money(inv.total), method, reference, actor.id]);
      await this.markPaid(c, inv, pid, money(inv.total), method, 'COUNTER');
      return this.detail(c, await this.invoice(c, inv.id));
    });
  }

  async paymentFailed(c: Queryable, orderId: string, error: string | null) {
    await c.query(`UPDATE payments SET last_error = $2 WHERE gateway_order_id = $1 AND status = 'CREATED'`, [orderId, error ?? 'payment failed']);
  }

  // ---------- refunds ----------

  /**
   * Queue a refund (the RefundJob sends it to the gateway outside any transaction). `dedupeKey` makes the same cause
   * refund once, however often its event is delivered.
   */
  async requestRefund(c: Queryable, inv: any, amount: number, reason: string, dedupeKey: string | null, requestedBy: string | null, paymentId?: string, opts: { capToRefundable?: boolean } = {}) {
    const { rows: pays } = await c.query(`SELECT * FROM payments WHERE invoice_id = $1 AND status = 'CAPTURED' ORDER BY captured_at`, [inv.id]);
    const pay = paymentId ? pays.find((p) => p.id === paymentId) : pays[0];
    if (!pay) throw new DomainError(422, 'NOTHING_PAID', 'nothing was paid on this invoice');
    const { rows: [q] } = await c.query(`SELECT coalesce(sum(amount), 0) AS queued FROM refunds WHERE invoice_id = $1 AND status <> 'FAILED' AND coalesce(dedupe_key, '') NOT LIKE 'duplicate:%'`, [inv.id]);
    const refundable = Math.round((money(inv.amount_paid) - money(q.queued)) * 100) / 100;
    amount = Math.round(amount * 100) / 100;
    // automatic refunds (policy, slot lost) give back at most what is left; a person asking for too much gets an error
    if (opts.capToRefundable) amount = Math.min(amount, refundable);
    if (amount <= 0) return null;
    if (amount > refundable) throw new DomainError(422, 'REFUND_TOO_LARGE', `at most ₹${refundable} can be refunded`);
    const { rows } = await c.query(
      `INSERT INTO refunds (id, invoice_id, payment_id, amount, reason, status, dedupe_key, requested_by) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`, [randomUUID(), inv.id, pay.id, amount, reason, dedupeKey, requestedBy]);
    return rows[0] ?? null;
  }

  /** Money is on its way back: refund PROCESSED, invoice amounts and status, event. Idempotent. */
  async refundProcessed(c: Queryable, refundId: string, gatewayRefundId: string | null) {
    const { rows } = await c.query(`UPDATE refunds SET status = 'PROCESSED', processed_at = now(), gateway_refund_id = coalesce(gateway_refund_id, $2), last_error = NULL
                                    WHERE id = $1 AND status <> 'PROCESSED' RETURNING *`, [refundId, gatewayRefundId]);
    const r = rows[0];
    if (!r || r.dedupe_key?.startsWith('duplicate:')) return; // a duplicate payment's refund leaves the invoice as it was
    const { rows: [inv] } = await c.query(
      `UPDATE invoices SET amount_refunded = amount_refunded + $2,
         status = CASE WHEN amount_refunded + $2 >= amount_paid THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING *`, [r.invoice_id, r.amount]);
    const data: RefundProcessed = {
      invoiceId: inv.id, invoiceNo: inv.invoice_no, refundId: r.id, sourceType: inv.source_type, sourceId: inv.source_id,
      accountPersonId: inv.account_person_id, patientName: inv.patient_name, amount: money(r.amount), invoiceStatus: inv.status, reason: r.reason,
    };
    await addToOutbox(c, Topics.billing, inv.id, envelope(EventTypes.refundProcessed, data, { tenantId: TenantContext.require().id, subject: inv.id }));
  }

  /**
   * Send queued refunds to the gateway (one hospital). Step 1 claims rows (SUBMITTING) and commits; step 2 calls the
   * gateway; step 3 saves the result. A crash between 2 and 3 leaves SUBMITTING: the next run asks the gateway
   * (findRefund by our id) before sending again, so a refund is never sent twice.
   */
  async submitRefunds(): Promise<number> {
    const tenant = TenantContext.require();
    const claimed = await this.db.tx(async (c) => (await c.query(
      `UPDATE refunds r SET status = 'SUBMITTING', attempts = attempts + 1
       FROM payments p WHERE p.id = r.payment_id AND r.id IN (
         SELECT id FROM refunds WHERE status = 'PENDING' OR (status = 'SUBMITTING' AND created_at < now() - interval '2 minutes')
         ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING r.*, p.gateway, p.gateway_payment_id, (r.attempts > 1) AS retry`)).rows);
    let done = 0;
    for (const r of claimed) {
      try {
        if (r.gateway === 'COUNTER') {
          // cash/UPI/card at the counter: nothing to send; the desk hands it back and records that (handedBack)
          await this.db.query(`UPDATE refunds SET status = 'HAND_BACK' WHERE id = $1 AND status = 'SUBMITTING'`, [r.id]);
          done++;
          continue;
        }
        const existing = r.retry ? await this.gateway.findRefund(r.gateway_payment_id, r.id) : null;
        const g = existing ?? await this.gateway.refund(r.gateway_payment_id, toPaise(money(r.amount)), { refundId: r.id, tenantId: tenant.id });
        await this.control.query(`INSERT INTO gateway_refs (ref, kind, tenant_id) VALUES ($1, 'REFUND', $2) ON CONFLICT DO NOTHING`, [g.id, tenant.id]);
        await this.db.tx(async (c) => {
          if (g.status === 'processed') await this.refundProcessed(c, r.id, g.id);
          else if (g.status === 'failed') await c.query(`UPDATE refunds SET status = 'FAILED', gateway_refund_id = $2, last_error = 'gateway refused the refund' WHERE id = $1`, [r.id, g.id]);
          else await c.query(`UPDATE refunds SET status = 'PROCESSING', gateway_refund_id = $2 WHERE id = $1 AND status = 'SUBMITTING'`, [r.id, g.id]);
        });
        done++;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        this.log.warn(`${tenant.slug}: refund ${r.id} attempt ${r.attempts}: ${msg}`);
        await this.db.query(`UPDATE refunds SET status = CASE WHEN attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END, last_error = $2 WHERE id = $1 AND status = 'SUBMITTING'`, [r.id, msg]);
      }
    }
    return done;
  }

  /** Counter refunds waiting to be handed back, at these branches (null = all), oldest first. */
  async toHandBack(branches: string[] | null) {
    const { rows } = await this.db.query(
      `SELECT r.id, r.amount, r.reason, r.created_at, p.method, i.id AS invoice_id, i.invoice_no, i.patient_name, i.patient_mrn, i.branch_id
       FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN invoices i ON i.id = r.invoice_id
       WHERE r.status = 'HAND_BACK' AND ($1::uuid[] IS NULL OR i.branch_id = ANY($1)) ORDER BY r.created_at LIMIT 200`, [branches]);
    return rows.map((r) => ({ id: r.id, amount: money(r.amount), reason: r.reason, requestedAt: r.created_at, paidBy: r.method, invoice: { id: r.invoice_id, invoiceNo: r.invoice_no }, patient: { name: r.patient_name, mrn: r.patient_mrn }, branchId: r.branch_id }));
  }

  /** The money went back to the patient at the counter: the refund is done (the patient is told, the invoice updated). */
  async handedBack(actor: Actor, refundId: string, method: 'CASH' | 'UPI' | 'CARD', at: (branchId: string) => boolean) {
    return this.db.tx(async (c) => {
      const { rows: [r] } = await c.query(`SELECT r.*, i.branch_id FROM refunds r JOIN invoices i ON i.id = r.invoice_id WHERE r.id = $1 FOR UPDATE OF r`, [refundId]);
      if (!r || !at(r.branch_id)) throw notFound('refund');
      if (r.status !== 'HAND_BACK') throw conflict('NOT_WAITING', r.status === 'PROCESSED' ? 'already handed back' : `the refund is ${String(r.status).toLowerCase()}`);
      await c.query('UPDATE refunds SET handed_back_by = $2, handed_back_method = $3 WHERE id = $1', [refundId, actor.id, method]);
      await this.refundProcessed(c, refundId, null);
      return { refundId, status: 'PROCESSED', amount: money(r.amount) };
    });
  }

  // ---------- webhooks ----------

  /** A verified gateway webhook, already routed to its hospital. Deduped on the gateway's event id. */
  async onWebhook(c: Queryable, eventId: string, event: string, payload: any) {
    const { rowCount } = await c.query('INSERT INTO processed_webhooks (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
    if (!rowCount) return 'duplicate';
    const p = payload?.payment?.entity;
    const r = payload?.refund?.entity;
    switch (event) {
      case 'payment.captured':
        await this.capture(c, p.order_id, { id: p.id, orderId: p.order_id, amount: p.amount, status: 'captured', method: p.method ?? null, error: null });
        return 'captured';
      case 'payment.failed':
        await this.paymentFailed(c, p.order_id, p.error_description ?? null);
        return 'failed';
      case 'refund.processed': {
        const { rows } = await c.query(`SELECT id FROM refunds WHERE gateway_refund_id = $1 OR id::text = $2`, [r.id, r.notes?.refundId ?? '']);
        if (rows[0]) await this.refundProcessed(c, rows[0].id, r.id);
        return 'refund processed';
      }
      case 'refund.failed':
        await c.query(`UPDATE refunds SET status = 'FAILED', last_error = 'gateway reported the refund failed' WHERE gateway_refund_id = $1 AND status <> 'PROCESSED'`, [r.id]);
        return 'refund failed';
      default:
        return 'ignored';
    }
  }

  /** Which hospital a webhook belongs to (order or refund id → tenant; recorded when we created them). */
  async tenantForWebhook(payload: any): Promise<string | null> {
    const refs = [payload?.refund?.entity?.id, payload?.payment?.entity?.order_id].filter(Boolean);
    if (!refs.length) return null;
    const { rows } = await this.control.query('SELECT tenant_id FROM gateway_refs WHERE ref = ANY($1) LIMIT 1', [refs]);
    return rows[0]?.tenant_id ?? null;
  }
}
