import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Payment gateway port (docs/LLD.md §10, adapter pattern). Amounts are in the smallest unit (paise), as Razorpay
 * uses them. Two adapters: RazorpayGateway (test or live keys) and SimulatedRazorpay (local dev and tests: same ids,
 * signatures and webhooks, no network).
 */
export interface GatewayOrder { id: string; amount: number; currency: string; receipt: string }
export interface GatewayPayment { id: string; orderId: string; amount: number; status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'; method: string | null; error: string | null }
export interface GatewayRefund { id: string; paymentId: string; amount: number; status: 'pending' | 'processed' | 'failed' }

export interface PaymentGateway {
  readonly name: 'RAZORPAY' | 'SIMULATED';
  /** public key id the browser checkout needs */
  readonly keyId: string;
  createOrder(input: { amount: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  /** `notes.refundId` is our refund id: lets findRefund() recover after a crash between "sent" and "saved" */
  refund(paymentId: string, amount: number, notes: { refundId: string; tenantId: string }): Promise<GatewayRefund>;
  findRefund(paymentId: string, refundId: string): Promise<GatewayRefund | null>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

const hmac = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Checkout success handler signature: HMAC-SHA256(order_id + "|" + payment_id, key secret). */
export const checkoutSignature = (orderId: string, paymentId: string, keySecret: string) => hmac(keySecret, `${orderId}|${paymentId}`);
export const verifyCheckoutSignature = (orderId: string, paymentId: string, signature: string, keySecret: string) =>
  same(checkoutSignature(orderId, paymentId, keySecret), signature);

/** Webhook signature: HMAC-SHA256(raw body, webhook secret), header X-Razorpay-Signature. */
export const webhookSignature = (raw: Buffer | string, secret: string) => hmac(secret, raw);
export const verifyWebhookSignature = (raw: Buffer | string, signature: string, secret: string) => same(webhookSignature(raw, secret), signature);

export const toPaise = (rupees: number) => Math.round(rupees * 100);
export const toRupees = (paise: number) => Math.round(paise) / 100;

export interface GatewayConfig { keyId: string; keySecret: string; webhookSecret: string }
export function gatewayConfig(): GatewayConfig {
  const c = { keyId: process.env.RAZORPAY_KEY_ID ?? '', keySecret: process.env.RAZORPAY_KEY_SECRET ?? '', webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? '' };
  if (!c.keyId || !c.keySecret || !c.webhookSecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET missing (run mc configure)');
  return c;
}
