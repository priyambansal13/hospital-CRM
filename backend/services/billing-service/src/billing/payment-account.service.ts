import { Injectable, Logger } from '@nestjs/common';
import { DomainError, isDev } from '@mc/nest-common';
import { type Queryable, TenantDbRouter } from '@mc/tenancy';
import { randomBytes, randomUUID } from 'node:crypto';

export interface ConnectInput { businessName: string; businessType: string; pan: string; accountNumber: string; ifsc: string; email: string }
const r2 = (n: number) => Math.round(n * 100) / 100;

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
    const { rows: [t] } = await pool.query(`SELECT count(*)::int n, coalesce(sum(amount), 0) amount, coalesce(sum(platform_fee), 0) fee FROM transfers WHERE status <> 'REVERSED'`);
    return {
      connected: a?.status === 'ACTIVE',
      account: a ? { status: a.status, provider: a.provider, linkedAccountId: a.linked_account_id, businessName: a.business_name, businessType: a.business_type, pan: a.pan_masked, bankLast4: a.bank_last4, ifsc: a.ifsc, email: a.contact_email, platformFeePercent: Number(a.platform_fee_percent), connectedAt: a.connected_at, connectedBy: a.connected_by } : null,
      transfers: { count: t.n, amount: Number(t.amount), platformFee: Number(t.fee) },
    };
  }

  /** Connect (or replace) the bank account patients' payments are paid out to. */
  async connect(by: string, i: ConnectInput) {
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(i.pan)) throw new DomainError(422, 'BAD_PAN', 'PAN must look like ABCDE1234F');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(i.ifsc)) throw new DomainError(422, 'BAD_IFSC', 'IFSC must look like HDFC0001234');
    if (!/^\d{9,18}$/.test(i.accountNumber)) throw new DomainError(422, 'BAD_ACCOUNT', 'account number: 9 to 18 digits');
    const linked = `acc_sim${randomBytes(7).toString('hex')}`;
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO payment_account (id, status, provider, linked_account_id, business_name, business_type, pan_masked, bank_last4, ifsc, contact_email, connected_by, connected_at)
        VALUES (true,'ACTIVE','ROUTE_SIMULATED',$1,$2,$3,$4,$5,$6,$7,$8,now())
        ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', provider = 'ROUTE_SIMULATED', linked_account_id = $1, business_name = $2, business_type = $3, pan_masked = $4, bank_last4 = $5, ifsc = $6, contact_email = $7, connected_by = $8, connected_at = now()`,
        [linked, i.businessName, i.businessType, `${i.pan.slice(0, 2)}XXXXX${i.pan.slice(-3)}`, i.accountNumber.slice(-4), i.ifsc, i.email, by]);
    });
    this.log.log(`payment account connected (${linked})`);
    return this.view();
  }

  /** Route: a captured online payment goes to the hospital's linked account, less the platform fee. */
  async transfer(c: Queryable, invoiceId: string, paymentId: string, amount: number) {
    const a = await this.get(c);
    if (!a) return;
    const fee = r2((amount * Number(a.platform_fee_percent)) / 100);
    await c.query(`INSERT INTO transfers (id, payment_id, invoice_id, linked_account_id, amount, platform_fee, status) VALUES ($1,$2,$3,$4,$5,$6,'SETTLED') ON CONFLICT (payment_id) DO NOTHING`,
      [randomUUID(), paymentId, invoiceId, a.linked_account_id, r2(amount - fee), fee]);
  }

  /** Dev convenience: hospitals created by MediCare (CLI) take online payments at once; self-serve ones connect in the setup guide. */
  async onProvisioned(c: Queryable, source: string, slug: string) {
    if (source !== 'SALES' || !isDev()) return;
    await c.query(`INSERT INTO payment_account (id, status, provider, linked_account_id, business_name, business_type, connected_by) VALUES (true,'ACTIVE','ROUTE_SIMULATED','acc_sim_dev',$1,'sales-led (dev)','provisioning') ON CONFLICT DO NOTHING`, [slug]);
  }
}
