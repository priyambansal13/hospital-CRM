import { DomainError } from '@mc/nest-common';
import type { GatewayConfig, GatewayOrder, GatewayPayment, GatewayRefund, PaymentGateway } from './gateway.js';

const API = process.env.RAZORPAY_API_URL ?? 'https://api.razorpay.com/v1';

/** Razorpay REST adapter (Orders, Payments, Refunds). Test keys (rzp_test_…) use Razorpay's test mode. */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'RAZORPAY' as const;
  readonly keyId: string;
  private readonly auth: string;

  constructor(cfg: GatewayConfig) {
    this.keyId = cfg.keyId;
    this.auth = `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(API + path, { method, headers: { authorization: this.auth, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new DomainError(502, 'UPSTREAM_UNAVAILABLE', `payment gateway unreachable: ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new DomainError(res.status >= 500 ? 502 : 422, 'GATEWAY_ERROR', json?.error?.description ?? `gateway ${res.status}`);
    return json as T;
  }

  async createOrder(i: { amount: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder> {
    const o = await this.call<any>('POST', '/orders', { amount: i.amount, currency: 'INR', receipt: i.receipt, notes: i.notes });
    return { id: o.id, amount: o.amount, currency: o.currency, receipt: o.receipt };
  }

  async fetchPayment(id: string): Promise<GatewayPayment> {
    const p = await this.call<any>('GET', `/payments/${encodeURIComponent(id)}`);
    return { id: p.id, orderId: p.order_id, amount: p.amount, status: p.status, method: p.method ?? null, error: p.error_description ?? null };
  }

  async refund(paymentId: string, amount: number, notes: { refundId: string; tenantId: string }): Promise<GatewayRefund> {
    const r = await this.call<any>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, speed: 'normal', notes });
    return { id: r.id, paymentId: r.payment_id, amount: r.amount, status: r.status };
  }

  async findRefund(paymentId: string, refundId: string): Promise<GatewayRefund | null> {
    const list = await this.call<{ items: any[] }>('GET', `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`);
    const r = list.items.find((x) => x.notes?.refundId === refundId);
    return r ? { id: r.id, paymentId: r.payment_id, amount: r.amount, status: r.status } : null;
  }
}
