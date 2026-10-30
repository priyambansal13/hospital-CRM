import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { AdminAudited, CurrentActor, DomainError, forbidden, Idempotent, notFound, parse } from '@mc/nest-common';
import { EntitlementsClient, inBranch, RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { verifyCheckoutSignature, gatewayConfig } from '../gateway/gateway.js';
import { SimulatedRazorpay } from '../gateway/simulator.js';
import { BillingService, toInvoice } from './billing.service.js';
import { invoicePdf } from './invoice-pdf.js';

const Uuid = z.uuid();
const id = (v: string, what: string) => { if (!Uuid.safeParse(v ?? '').success) throw notFound(what); return v; };
const Verify = z.object({ orderId: z.string().min(5).max(80), paymentId: z.string().min(5).max(80), signature: z.string().regex(/^[0-9a-f]{64}$/) });
const SimPay = z.object({ orderId: z.string().min(5).max(80), outcome: z.enum(['success', 'failure']).default('success'), method: z.enum(['upi', 'card', 'netbanking', 'wallet']).default('upi') });
const Collect = z.object({ sourceType: z.enum(['APPOINTMENT', 'LAB_ORDER']).default('APPOINTMENT'), sourceId: z.uuid(), method: z.enum(['CASH', 'UPI', 'CARD']), reference: z.string().trim().max(60).nullable().default(null) });
const Refund = z.object({ amount: z.number().positive().max(10_000_000), reason: z.string().trim().min(3).max(200) });
const List = z.object({ branchId: z.uuid().optional(), status: z.enum(['ISSUED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOID']).optional(), q: z.string().trim().max(60).optional(), date: z.iso.date().optional() });

/** Patients: their invoices, paying online. Staff: the billing desk (lists, counter payments, refunds). */
@Controller('v1')
@RequireModule('billing')
export class BillingController {
  constructor(private readonly db: TenantDbRouter, private readonly billing: BillingService, private readonly entitlements: EntitlementsClient) {}

  private caps(actor: Actor) {
    return this.entitlements.capabilities(TenantContext.require().id, actor);
  }

  /** Staff holding the permission at a given branch (review B-1). */
  private async staffAt(actor: Actor, permission: string) {
    if (actor.kind !== 'staff') return () => false;
    const caps = await this.caps(actor);
    return (branchId: string) => inBranch(caps, permission, branchId);
  }

  @Get('me/invoices')
  @RequirePermission('invoice:read:own')
  async mine(@CurrentActor() actor: Actor) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'patients only');
    const { rows } = await this.db.query(`SELECT * FROM invoices WHERE account_person_id = $1 ORDER BY issued_at DESC LIMIT 200`, [actor.id]);
    return rows.map(toInvoice);
  }

  @Get('invoices/:id')
  async get(@Param('id') invoiceId: string, @CurrentActor() actor: Actor) {
    const pool = await this.db.current();
    const r = await this.billing.assertCanSee(pool, actor, id(invoiceId, 'invoice'), await this.staffAt(actor, 'invoice:read:branch'));
    return this.billing.detail(pool, r);
  }

  @Get('invoices/:id/pdf')
  async pdf(@Param('id') invoiceId: string, @CurrentActor() actor: Actor, @Res({ passthrough: true }) reply: any) {
    const pool = await this.db.current();
    const r = await this.billing.assertCanSee(pool, actor, id(invoiceId, 'invoice'), await this.staffAt(actor, 'invoice:read:branch'));
    const body = await invoicePdf(TenantContext.require().name, await this.billing.detail(pool, r));
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${r.invoice_no}.pdf"`).header('cache-control', 'private, no-store');
    return body;
  }

  /** Billing desk list for a day (invoices issued or paid that day), with the day's totals. */
  @Get('invoices')
  @RequirePermission('invoice:read:branch')
  async list(@Query() query: unknown, @CurrentActor() actor: Actor) {
    const q = parse(List, query);
    // one branch (?branchId, checked by the guard), or every branch the person works at (review B-1)
    const scope = q.branchId ? [q.branchId] : (await this.caps(actor)).branchScopes?.['invoice:read:branch'] ?? null;
    const tz = 'Asia/Kolkata';
    const pool = await this.db.current();
    const { rows: [{ day }] } = await pool.query(`SELECT to_char(coalesce($1::date, (now() AT TIME ZONE $2)::date), 'YYYY-MM-DD') AS day`, [q.date ?? null, tz]);
    const inDay = (col: string) => `(${col} AT TIME ZONE '${tz}')::date = $1::date`;
    const args: unknown[] = [day, scope];
    const inScope = (alias: string) => `($2::uuid[] IS NULL OR ${alias}.branch_id = ANY($2))`;
    let where = `${inScope('i')} AND (${inDay('i.issued_at')} OR ${inDay('i.paid_at')} OR EXISTS (SELECT 1 FROM refunds r WHERE r.invoice_id = i.id AND ${inDay('r.created_at')}))`;
    if (q.status) { args.push(q.status); where += ` AND i.status = $${args.length}`; }
    if (q.q) { args.push(`%${q.q.toLowerCase().replace(/[%_\\]/g, '')}%`); where += ` AND (lower(i.invoice_no) LIKE $${args.length} OR lower(i.patient_name) LIKE $${args.length} OR lower(i.patient_mrn) LIKE $${args.length})`; }
    const [{ rows }, { rows: [t] }] = await Promise.all([
      pool.query(`SELECT i.* FROM invoices i WHERE ${where} ORDER BY i.issued_at DESC LIMIT 200`, args),
      pool.query(`SELECT
          coalesce((SELECT sum(p.amount) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE ${inScope('i')} AND p.status = 'CAPTURED' AND p.channel = 'ONLINE' AND ${inDay('p.captured_at')}), 0) AS online,
          coalesce((SELECT sum(p.amount) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE ${inScope('i')} AND p.status = 'CAPTURED' AND p.channel = 'COUNTER' AND ${inDay('p.captured_at')}), 0) AS counter,
          coalesce((SELECT sum(r.amount) FROM refunds r JOIN invoices i ON i.id = r.invoice_id WHERE ${inScope('i')} AND r.status = 'PROCESSED' AND ${inDay('r.processed_at')}), 0) AS refunded,
          coalesce((SELECT sum(i.total) FROM invoices i WHERE ${inScope('i')} AND i.status = 'ISSUED'), 0) AS outstanding,
          (SELECT count(*) FROM refunds r JOIN invoices i ON i.id = r.invoice_id WHERE ${inScope('i')} AND r.status = 'FAILED')::int AS failed_refunds`, [day, scope]),
    ]);
    return {
      date: day,
      totals: { collectedOnline: Number(t.online), collectedAtCounter: Number(t.counter), refunded: Number(t.refunded), outstanding: Number(t.outstanding), failedRefunds: t.failed_refunds },
      items: rows.map(toInvoice),
    };
  }

  /**
   * Checkout success handler (the browser posts what the gateway's checkout returned). Fast path: confirms without
   * waiting for the webhook; both are idempotent.
   */
  @Post('payments/verify')
  @HttpCode(200)
  @RequirePermission('payment:create:own')
  async verify(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const v = parse(Verify, body);
    if (!verifyCheckoutSignature(v.orderId, v.paymentId, v.signature, gatewayConfig().keySecret)) throw new DomainError(400, 'INVALID_SIGNATURE', 'payment signature does not match');
    const { rows } = await this.db.query(`SELECT i.* FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.gateway_order_id = $1`, [v.orderId]);
    if (!rows[0] || rows[0].account_person_id !== actor.id) throw notFound('payment order');
    const gp = await this.billing.gateway.fetchPayment(v.paymentId); // network: outside the transaction
    if (gp.orderId !== v.orderId) throw new DomainError(400, 'INVALID_SIGNATURE', 'payment does not belong to this order');
    if (gp.status !== 'captured') throw new DomainError(409, 'PAYMENT_NOT_CAPTURED', `payment is ${gp.status}`);
    await this.db.tx((c) => this.billing.capture(c, v.orderId, gp));
    return this.billing.detail(await this.db.current(), (await this.billing.invoice(await this.db.current(), rows[0].id)));
  }

  /** Dev only (simulated gateway): what Razorpay Checkout would do when the patient pays or the bank declines. */
  @Post('payments/simulator/pay')
  @HttpCode(200)
  @RequirePermission('payment:create:own')
  async simulate(@Body() body: unknown, @CurrentActor() actor: Actor) {
    if (!(this.billing.gateway instanceof SimulatedRazorpay)) throw notFound('route');
    const v = parse(SimPay, body);
    const { rows } = await this.db.query(`SELECT i.account_person_id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.gateway_order_id = $1`, [v.orderId]);
    if (!rows[0] || rows[0].account_person_id !== actor.id) throw notFound('payment order');
    const out = await this.billing.gateway.pay(v.orderId, v.outcome, v.method);
    if (!out) throw notFound('payment order');
    return out;
  }

  /** Front desk: settle a pay-at-clinic invoice in cash, UPI (hospital QR) or card. */
  @Post('desk/collect')
  @Idempotent()
  @RequirePermission('payment:collect:branch')
  async collect(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const v = parse(Collect, body);
    return this.billing.collectAtCounter(actor, { sourceType: v.sourceType, sourceId: v.sourceId }, v.method, v.reference, await this.staffAt(actor, 'payment:collect:branch'));
  }

  /** Admin: a manual (goodwill / correction) refund on a paid invoice. */
  @Post('invoices/:id/refunds')
  @Idempotent()
  @AdminAudited('REFUND')
  @RequirePermission('refund:create:branch')
  async refund(@Param('id') invoiceId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const v = parse(Refund, body);
    return this.db.tx(async (c) => {
      const inv = await this.billing.invoice(c, id(invoiceId, 'invoice'), true);
      if (!inv || !(await this.staffAt(actor, 'refund:create:branch'))(inv.branch_id)) throw notFound('invoice');
      if (!['PAID', 'PARTIALLY_REFUNDED'].includes(inv.status)) throw new DomainError(422, 'NOTHING_PAID', `invoice is ${inv.status.toLowerCase()}`);
      const r = await this.billing.requestRefund(c, inv, v.amount, v.reason, null, actor.id);
      return { refundId: r?.id, status: r?.status, amount: v.amount };
    });
  }
}
