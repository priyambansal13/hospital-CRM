import { createHash, randomBytes } from 'node:crypto';
import { isDev } from '@mc/nest-common';

/**
 * Recurring payments for hospitals paying MediCare (port). A card (or UPI AutoPay) is authorised once as a mandate;
 * renewals charge it without the customer present. Production adapter: Razorpay recurring payments / Subscriptions
 * (needs live keys and mandate registration; not built yet). Local dev and tests: SimulatedCards below.
 */
export interface Mandate { mandateId: string; brand: string; last4: string }
export interface Charge { paymentId: string | null; ok: boolean; error: string | null }

export interface RecurringGateway {
  readonly name: 'SIMULATED' | 'RAZORPAY';
  /** authorise a card for future charges (simulated: the card number itself; production: a hosted mandate flow) */
  authorise(card: { number: string; expiry: string; name: string }): Promise<Mandate>;
  charge(mandateId: string, amountPaise: number, receipt: string): Promise<Charge>;
}

/**
 * Test cards, like a gateway's test mode: 4111 1111 1111 1111 (and any other valid number) always pays;
 * 4000 0000 0000 0002 is accepted as a mandate but every charge is declined (to test dunning).
 */
export const DECLINING_CARD = '4000000000000002';

function luhn(n: string) {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export class SimulatedCards implements RecurringGateway {
  readonly name = 'SIMULATED' as const;
  constructor() {
    if (!isDev()) throw new Error('the simulated card gateway is for local development only');
  }

  async authorise(card: { number: string; expiry: string; name: string }): Promise<Mandate> {
    const n = card.number.replace(/\s|-/g, '');
    if (!/^\d{13,19}$/.test(n) || !luhn(n)) throw new Error('card number is not valid');
    const m = /^(\d{2})\/(\d{2})$/.exec(card.expiry.trim());
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) throw new Error('expiry must be MM/YY');
    const exp = new Date(2000 + Number(m[2]), Number(m[1]), 1);
    if (exp.getTime() < Date.now()) throw new Error('card has expired');
    // the mandate id encodes whether charges succeed (test mode): no card number is stored, only last 4 digits
    const declines = n === DECLINING_CARD;
    return { mandateId: `${declines ? 'mdt_decl' : 'mdt_ok'}_${createHash('sha256').update(n + randomBytes(8).toString('hex')).digest('hex').slice(0, 14)}`, brand: n.startsWith('4') ? 'Visa' : n.startsWith('5') ? 'Mastercard' : 'Card', last4: n.slice(-4) };
  }

  async charge(mandateId: string, amountPaise: number, _receipt: string): Promise<Charge> {
    if (amountPaise <= 0) return { paymentId: null, ok: true, error: null };
    if (mandateId.startsWith('mdt_decl')) return { paymentId: null, ok: false, error: 'card declined by the bank (insufficient funds)' };
    return { paymentId: `pay_sim${randomBytes(7).toString('hex')}`, ok: true, error: null };
  }
}

export const RECURRING_GATEWAY = Symbol('RECURRING_GATEWAY');
