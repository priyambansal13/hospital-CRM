import { Injectable, Logger } from '@nestjs/common';
import { EventTypes, type PayoutAccountChanged, Topics } from '@mc/contracts';
import { DomainError, isDev, recordAdminAction } from '@mc/nest-common';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomBytes, randomUUID } from 'node:crypto';

export interface ConnectInput { businessName: string; businessType: string; pan: string; accountNumber: string; ifsc: string; email: string }
const r2 = (n: number) => Math.round(n * 100) / 100;
/** after the payout account is REPLACED, money to the new account waits this long (review B-5) */
export const PAYOUT_HOLD_HOURS = Number(process.env.PAYOUT_HOLD_HOURS ?? 48);

/**
 * Where patients' online payments go (Razorpay Route): one linked account per hospital, each captured payment is
 * transferred to it less MediCare's platform fee. Local dev: a simulated linked account (the real Route onboarding
 * with KYC needs live keys and is not built yet). No account → patients pay at the hospital only.
 */
@Injectable()
export class PaymentAccountService {
  private readonly log = new Logger('PaymentAccount');
  constructor(private readonly db: TenantDbRouter) {}

  async get(c?: Queryable) {
    const { rows: [a] } = await (c ?? (await this.db.current())).query('SELECT * FROM payment_account');
    return a ?? null;
  }

  async onlineReady(c?: Queryable) {
    return (await this.get(c))?.status === 'ACTIVE';
  }

  async assertReady(c?: Queryable) {
    if (!(await this.onlineReady(c))) throw new DomainError(409, 'ONLINE_PAYMENTS_NOT_SET_UP', 'this hospital does not take online payments yet: pay at the hospital');
  }

  async view() {
    const pool = await this.db.current();
    const a = await this.get(pool);
    const { rows: [t] } = await pool.query(`SELECT count(*)::int n, coalesce(sum(amount), 0) amount, coalesce(sum(platform_fee), 0) fee, coalesce(sum(amount) FILTER (WHERE status = 'ON_HOLD'), 0) held FROM transfers WHERE status <> 'REVERSED'`);
    return {
      connected: a?.status === 'ACTIVE',
      holdUntil: a?.payout_hold_until && new Date(a.payout_hold_until).getTime() > Date.now() ? a.payout_hold_until : null,
      account: a ? { status: a.status, provider: a.provider, linkedAccountId: a.linked_account_id, businessName: a.business_name, businessType: a.business_type, pan: a.pan_masked, bankLast4: a.bank_last4, ifsc: a.ifsc, email: a.contact_email, platformFeePercent: Number(a.platform_fee_percent), connectedAt: a.connected_at, connectedBy: a.connected_by } : null,
      transfers: { count: t.n, amount: Number(t.amount), platformFee: Number(t.fee), onHold: Number(t.held) },
    };
  }

  /**
   * Connect (or replace) the bank account patients' payments are paid out to (review B-5). Replacing an account needs a
   * step-up code e-mailed to the person (iam), puts new payouts on hold for PAYOUT_HOLD_HOURS, is kept in the history,
   * and the hospital's owners are told.
   */
  async connect(actor: Actor, i: ConnectInput, stepUpCode: string | null) {
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(i.pan)) throw new DomainError(422, 'BAD_PAN', 'PAN must look like ABCDE1234F');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(i.ifsc)) throw new DomainError(422, 'BAD_IFSC', 'IFSC must look like HDFC0001234');
    if (!/^\d{9,18}$/.test(i.accountNumber)) throw new DomainError(422, 'BAD_ACCOUNT', 'account number: 9 to 18 digits');
    const by = actor.email ?? actor.id;
    const prev = await this.get();
    // the placeholder dev hospitals get at provisioning is not a real account: the first real one is a plain connect
    const replacing = prev?.status === 'ACTIVE' && prev.connected_by !== 'provisioning';
    if (replacing) await this.verifyStepUp(actor, stepUpCode);
    const linked = `acc_sim${randomBytes(7).toString('hex')}`;
    const hold = replacing ? new Date(Date.now() + PAYOUT_HOLD_HOURS * 3_600_000) : null;
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO payment_account (id, status, provider, linked_account_id, business_name, business_type, pan_masked, bank_last4, ifsc, contact_email, connected_by, connected_at, payout_hold_until)
        VALUES (true,'ACTIVE','ROUTE_SIMULATED',$1,$2,$3,$4,$5,$6,$7,$8,now(),$9)
        ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', provider = 'ROUTE_SIMULATED', linked_account_id = $1, business_name = $2, business_type = $3, pan_masked = $4, bank_last4 = $5, ifsc = $6, contact_email = $7, connected_by = $8, connected_at = now(), payout_hold_until = $9`,
        [linked, i.businessName, i.businessType, `${i.pan.slice(0, 2)}XXXXX${i.pan.slice(-3)}`, i.accountNumber.slice(-4), i.ifsc, i.email, by, hold]);
      const change = replacing ? 'REPLACED' : 'CONNECTED';
      await c.query(`INSERT INTO payment_account_history (id, changed_by, change, bank_last4, ifsc, prev_bank_last4, prev_ifsc, hold_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), by, change, i.accountNumber.slice(-4), i.ifsc, prev?.bank_last4 ?? null, prev?.ifsc ?? null, hold]);
      const data: PayoutAccountChanged = { change, by, bankLast4: i.accountNumber.slice(-4), ifsc: i.ifsc, prevBankLast4: prev?.bank_last4 ?? null, holdUntil: hold?.toISOString() ?? null };
      await addToOutbox(c, Topics.billing, TenantContext.require().id, envelope(EventTypes.payoutAccountChanged, data, { tenantId: TenantContext.require().id }));
      // in the change's transaction: the account is never changed without its audit entry (review B-8)
      await recordAdminAction('billing-service', actor, { action: 'UPDATE', resourceType: 'PAYOUT_ACCOUNT', changes: [change.toLowerCase()] });
    });
    this.log.log(`payment account ${replacing ? 'replaced (payouts held)' : 'connected'} (${linked})`);
    return this.view();
  }

  /** iam checks the code it e-mailed to this person for this purpose (one use). */
  private async verifyStepUp(actor: Actor, code: string | null) {
    if (!code) throw new DomainError(422, 'STEP_UP_REQUIRED', 'changing the payout account needs the confirmation code we e-mail you');
    const res = await fetch(`${process.env.SVC_URL_IAM ?? 'http://localhost:4402'}/internal/tenants/${TenantContext.require().id}/step-up/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' },
      body: JSON.stringify({ userId: actor.id, purpose: 'PAYOUT_ACCOUNT', code }), signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res) throw new DomainError(503, 'IAM_UNAVAILABLE', 'could not check the code; try again');
    if (!res.ok) {
      const p = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
      throw new DomainError(422, p.code ?? 'WRONG_CODE', p.detail ?? 'that code is not right');
    }
  }

  /** Changes to the payout account, newest first. */
  async history() {
    const { rows } = await this.db.query('SELECT * FROM payment_account_history ORDER BY changed_at DESC LIMIT 50');
    return rows.map((r) => ({ at: r.changed_at, by: r.changed_by, change: r.change, bankLast4: r.bank_last4, ifsc: r.ifsc, prevBankLast4: r.prev_bank_last4, holdUntil: r.hold_until }));
  }

  /** Held payouts whose hold has ended are paid out (RefundJob, every few seconds). */
  async releaseHeld(c?: Queryable) {
    const { rowCount } = await (c ?? (await this.db.current())).query(`UPDATE transfers SET status = 'SETTLED' WHERE status = 'ON_HOLD' AND release_at <= now()`);
    return rowCount ?? 0;
  }

  /** Route: a captured online payment goes to the hospital's linked account, less the platform fee. */
  async transfer(c: Queryable, invoiceId: string, paymentId: string, amount: number) {
    const a = await this.get(c);
    if (!a) return;
    const fee = r2((amount * Number(a.platform_fee_percent)) / 100);
    // a newly replaced account: the money waits until the hold ends (review B-5)
    const held = a.payout_hold_until && new Date(a.payout_hold_until).getTime() > Date.now();
    await c.query(`INSERT INTO transfers (id, payment_id, invoice_id, linked_account_id, amount, platform_fee, status, release_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (payment_id) DO NOTHING`,
      [randomUUID(), paymentId, invoiceId, a.linked_account_id, r2(amount - fee), fee, held ? 'ON_HOLD' : 'SETTLED', held ? a.payout_hold_until : null]);
  }

  /** Dev convenience: hospitals created by MediCare (CLI) take online payments at once; self-serve ones connect in the setup guide. */
  async onProvisioned(c: Queryable, source: string, slug: string) {
    if (source !== 'SALES' || !isDev()) return;
    await c.query(`INSERT INTO payment_account (id, status, provider, linked_account_id, business_name, business_type, connected_by) VALUES (true,'ACTIVE','ROUTE_SIMULATED','acc_sim_dev',$1,'sales-led (dev)','provisioning') ON CONFLICT DO NOTHING`, [slug]);
  }
}
