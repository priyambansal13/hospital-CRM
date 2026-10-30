import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { isDev } from '@mc/nest-common';

/**
 * Recurring payments for hospitals paying MediCare (port). The customer authorises a card (or UPI AutoPay) as a
 * mandate ON THE GATEWAY'S OWN PAGE: card numbers never pass through MediCare's apps or services (review B-6). Renewals
 * charge the mandate without the customer present.
 *
 * Adapters, chosen by SAAS_PAYMENTS (review A-1):
 *  - simulated: local development and tests (the default with MC_DEV=true); a stand-in hosted page.
 *  - manual: no card payments; hospitals pay invoices by bank transfer and support records them (the default
 *    elsewhere, so the service always starts).
 *  - razorpay: Razorpay recurring payments; needs live keys and mandate registration (not built yet).
 */
export interface Mandate { mandateId: string; brand: string; last4: string }
export interface Charge { paymentId: string | null; ok: boolean; error: string | null }

export interface RecurringGateway {
  readonly name: 'SIMULATED' | 'MANUAL' | 'RAZORPAY';
  /** can hospitals pay by card at all? (manual: bank transfer only) */
  readonly takesCards: boolean;
  /** the gateway's hosted page for this session; the customer comes back to returnUrl */
  startMandate(s: { sessionId: string; returnUrl: string; hospital: string }): Promise<{ url: string }>;
  /** after the return: ask the gateway (server to server) what was authorised; never trust the browser */
  completeMandate(sessionId: string): Promise<Mandate>;
  charge(mandateId: string, amountPaise: number, receipt: string): Promise<Charge>;
}

/**
 * Test cards, like a gateway's test mode: 4111 1111 1111 1111 (and any other valid number) always pays;
 * 4000 0000 0000 0002 is accepted as a mandate but every charge is declined (to test dunning).
 */
export const DECLINING_CARD = '4000000000000002';

export function luhn(n: string) {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** What the simulated gateway's page does with the card typed into it (a real gateway does this on its side). */
export function simulateAuthorise(card: { number: string; expiry: string; name: string }): Mandate {
  const n = card.number.replace(/\s|-/g, '');
  if (!/^\d{13,19}$/.test(n) || !luhn(n)) throw new Error('card number is not valid');
  const m = /^(\d{2})\/(\d{2})$/.exec(card.expiry.trim());
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) throw new Error('expiry must be MM/YY');
  const exp = new Date(2000 + Number(m[2]), Number(m[1]), 1);
  if (exp.getTime() < Date.now()) throw new Error('card has expired');
  // the mandate id encodes whether charges succeed (test mode): no card number is kept, only the last 4 digits
  const declines = n === DECLINING_CARD;
  return { mandateId: `${declines ? 'mdt_decl' : 'mdt_ok'}_${createHash('sha256').update(n + randomBytes(8).toString('hex')).digest('hex').slice(0, 14)}`, brand: n.startsWith('4') ? 'Visa' : n.startsWith('5') ? 'Mastercard' : 'Card', last4: n.slice(-4) };
}

export class SimulatedCards implements RecurringGateway {
  readonly name = 'SIMULATED' as const;
  readonly takesCards = true;
  constructor(private readonly db: pg.Pool) {
    if (!isDev()) throw new Error('the simulated card gateway is for local development only: set SAAS_PAYMENTS=manual');
  }

  async startMandate(s: { sessionId: string; returnUrl: string }) {
    // the stand-in hosted page is served by this service under /v1/sim-gateway (through the API gateway)
    const base = process.env.PUBLIC_API_URL ?? 'http://localhost:61000';
    return { url: `${base}/api/subscription/v1/sim-gateway/mandate/${s.sessionId}?${new URLSearchParams({ return: s.returnUrl })}` };
  }

  async completeMandate(sessionId: string): Promise<Mandate> {
    const { rows: [m] } = await this.db.query('SELECT mandate, error FROM sim_mandates WHERE session_id = $1', [sessionId]);
    if (!m) throw new Error('no card was authorised on the payment page');
    if (m.error) throw new Error(m.error);
    return m.mandate as Mandate;
  }

  async charge(mandateId: string, amountPaise: number, _receipt: string): Promise<Charge> {
    if (amountPaise <= 0) return { paymentId: null, ok: true, error: null };
    if (mandateId.startsWith('mdt_decl')) return { paymentId: null, ok: false, error: 'card declined by the bank (insufficient funds)' };
    return { paymentId: `pay_sim${randomBytes(7).toString('hex')}`, ok: true, error: null };
  }
}

/** No card payments: MediCare sends invoices and support records the bank transfers (OFFLINE). */
export class ManualPayments implements RecurringGateway {
  readonly name = 'MANUAL' as const;
  readonly takesCards = false;
  async startMandate(): Promise<{ url: string }> { throw new Error('card payments are not set up: invoices are paid by bank transfer'); }
  async completeMandate(): Promise<Mandate> { throw new Error('card payments are not set up'); }
  async charge(): Promise<Charge> { return { paymentId: null, ok: false, error: 'card payments are not set up: pay by bank transfer' }; }
}

export function recurringGateway(db: pg.Pool): RecurringGateway {
  const mode = process.env.SAAS_PAYMENTS ?? (isDev() ? 'simulated' : 'manual');
  if (mode === 'simulated') return new SimulatedCards(db);
  if (mode === 'manual') return new ManualPayments();
  if (mode === 'razorpay') throw new Error('SAAS_PAYMENTS=razorpay: the Razorpay recurring adapter is not built yet (needs live keys); use manual');
  throw new Error(`SAAS_PAYMENTS must be simulated, manual or razorpay (got "${mode}")`);
}

export const RECURRING_GATEWAY = Symbol('RECURRING_GATEWAY');
