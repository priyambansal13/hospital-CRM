import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkoutSignature, toPaise, toRupees, verifyCheckoutSignature, verifyWebhookSignature, webhookSignature } from './gateway.js';

describe('Razorpay signatures', () => {
  it('checkout: HMAC-SHA256(order_id|payment_id, key secret), as Razorpay documents it', () => {
    const expected = createHmac('sha256', 'key_secret').update('order_ABC|pay_XYZ').digest('hex');
    expect(checkoutSignature('order_ABC', 'pay_XYZ', 'key_secret')).toBe(expected);
    expect(verifyCheckoutSignature('order_ABC', 'pay_XYZ', expected, 'key_secret')).toBe(true);
    expect(verifyCheckoutSignature('order_ABC', 'pay_OTHER', expected, 'key_secret')).toBe(false);
    expect(verifyCheckoutSignature('order_ABC', 'pay_XYZ', expected, 'wrong_secret')).toBe(false);
    expect(verifyCheckoutSignature('order_ABC', 'pay_XYZ', 'short', 'key_secret')).toBe(false);
  });

  it('webhook: HMAC-SHA256 over the exact raw body', () => {
    const raw = Buffer.from('{"event":"payment.captured","payload":{}}');
    const sig = webhookSignature(raw, 'whsec');
    expect(verifyWebhookSignature(raw, sig, 'whsec')).toBe(true);
    // re-serialised JSON (spacing) must not verify: the raw bytes are what is signed
    expect(verifyWebhookSignature(Buffer.from('{"event": "payment.captured","payload":{}}'), sig, 'whsec')).toBe(false);
  });

  it('paise conversion has no float drift', () => {
    expect(toPaise(499.99)).toBe(49999);
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(toRupees(49999)).toBe(499.99);
  });
});
