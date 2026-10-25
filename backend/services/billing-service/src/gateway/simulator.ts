import { Logger } from '@nestjs/common';
import type { Redis } from '@mc/nest-common';
import { randomBytes } from 'node:crypto';
import { checkoutSignature, type GatewayConfig, type GatewayOrder, type GatewayPayment, type GatewayRefund, type PaymentGateway, webhookSignature } from './gateway.js';

const id = (prefix: string) => `${prefix}_sim${randomBytes(7).toString('hex')}`;
const TTL = 7 * 24 * 3600;

/**
 * Local stand-in for Razorpay (dev and automated tests; refused outside dev). Same ids, checkout signature and
 * webhook format/signature as Razorpay, state in Redis. Webhooks are POSTed to billing-service like Razorpay would,
 * after a short delay and delivered TWICE by default, so retry dedupe is exercised on every payment.
 */
export class SimulatedRazorpay implements PaymentGateway {
  readonly name = 'SIMULATED' as const;
  readonly keyId: string;
  private readonly log = new Logger('SimulatedRazorpay');

  constructor(private readonly cfg: GatewayConfig, private readonly redis: Redis) {
    this.keyId = cfg.keyId;
  }

  private async get<T>(key: string): Promise<T | null> {
    const v = await this.redis.get(`rzpsim:${key}`);
    return v ? (JSON.parse(v) as T) : null;
  }
  private put(key: string, v: unknown) {
    return this.redis.set(`rzpsim:${key}`, JSON.stringify(v), 'EX', TTL);
  }

  async createOrder(i: { amount: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder> {
    const o = { id: id('order'), amount: i.amount, currency: 'INR', receipt: i.receipt, notes: i.notes, status: 'created' };
    await this.put(`order:${o.id}`, o);
    return o;
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const p = await this.get<GatewayPayment>(`payment:${paymentId}`);
    if (!p) throw new Error(`simulated payment ${paymentId} not found`);
    return p;
  }

  async refund(paymentId: string, amount: number, notes: { refundId: string; tenantId: string }): Promise<GatewayRefund> {
    const p = await this.fetchPayment(paymentId);
    const r: GatewayRefund & { notes: typeof notes } = { id: id('rfnd'), paymentId, amount, status: 'processed', notes };
    await this.redis.rpush(`rzpsim:refunds:${paymentId}`, JSON.stringify(r));
    await this.redis.expire(`rzpsim:refunds:${paymentId}`, TTL);
    this.deliver('refund.processed', { refund: { entity: { id: r.id, entity: 'refund', payment_id: paymentId, amount, currency: 'INR', status: 'processed', notes } }, payment: { entity: this.paymentEntity(p) } });
    return r;
  }

  async findRefund(paymentId: string, refundId: string): Promise<GatewayRefund | null> {
    const all = (await this.redis.lrange(`rzpsim:refunds:${paymentId}`, 0, -1)).map((x) => JSON.parse(x));
    return all.find((r) => r.notes?.refundId === refundId) ?? null;
  }

  /**
   * What Razorpay Checkout does when the patient pays: a payment against the order, the success-handler fields
   * (order id, payment id, signature) for the browser, and the payment.captured / payment.failed webhook.
   */
  async pay(orderId: string, outcome: 'success' | 'failure', method: string) {
    const o = await this.get<GatewayOrder & { notes: Record<string, string> }>(`order:${orderId}`);
    if (!o) return null;
    const p: GatewayPayment & { notes: Record<string, string> } = {
      id: id('pay'), orderId, amount: o.amount, method, notes: o.notes,
      status: outcome === 'success' ? 'captured' : 'failed', error: outcome === 'success' ? null : 'Payment was declined by the bank (simulated)',
    };
    await this.put(`payment:${p.id}`, p);
    this.deliver(outcome === 'success' ? 'payment.captured' : 'payment.failed', { payment: { entity: this.paymentEntity(p) } });
    return outcome === 'success'
      ? { razorpay_order_id: orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(orderId, p.id, this.cfg.keySecret) }
      : { error: { code: 'BAD_REQUEST_ERROR', description: p.error, metadata: { order_id: orderId, payment_id: p.id } } };
  }

  private paymentEntity(p: GatewayPayment & { notes?: Record<string, string> }) {
    return { id: p.id, entity: 'payment', amount: p.amount, currency: 'INR', status: p.status, order_id: p.orderId, method: p.method, error_description: p.error, notes: p.notes ?? {} };
  }

  /** POST the webhook to ourselves, signed like Razorpay; fire and forget. */
  private deliver(event: string, payload: unknown) {
    const url = process.env.BILLING_WEBHOOK_URL ?? 'http://localhost:4409/v1/webhooks/razorpay';
    const eventId = id('evt');
    const body = JSON.stringify({ entity: 'event', account_id: 'acc_simulated', event, contains: Object.keys(payload as object), payload, created_at: Math.floor(Date.now() / 1000) });
    const times = Number(process.env.SIM_WEBHOOK_DELIVERIES ?? 2);
    const delay = Number(process.env.SIM_WEBHOOK_DELAY_MS ?? 800);
    for (let i = 0; i < times; i++) {
      setTimeout(() => {
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': webhookSignature(body, this.cfg.webhookSecret), 'x-razorpay-event-id': eventId }, body })
          .then((r) => { if (!r.ok) this.log.warn(`webhook ${event} → ${r.status}`); })
          .catch((e) => this.log.warn(`webhook ${event} failed: ${(e as Error).message}`));
      }, delay * (i + 1));
    }
  }
}
