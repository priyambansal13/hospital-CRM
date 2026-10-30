import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { type BillingNotice, EventTypes, type SubscriptionStatusChanged, Topics } from '@mc/contracts';
import { CONTROL_DB, DomainError, isDev, PLACEMENTS, retryInBackground } from '@mc/nest-common';
import { addToOutbox, envelope, type PlacementSource, type Queryable, withTx } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { type Contract, PlansService } from '../plans.service.js';
import { calculate, type ChargeInput, type Invoice, monthlyTotal, remainingFraction, type UsageInput } from './calculator.js';
import { type Mandate, RECURRING_GATEWAY, type RecurringGateway } from './gateway.js';
import { loadPriceBook, type PriceBook, seedPriceBooks } from './pricebook.js';
import { UsageService } from './usage.service.js';

/** docs/FEATURES-AND-PLANS.md §4.3: 3 retries a day apart, then 7 days' grace, then suspended; cancelled after 60. */
export const DUNNING = { retries: 3, retryEveryH: 24, graceDays: 7, cancelAfterSuspendedDays: 60, trialWarningDays: 3 };
const H = 3600_000;
type NoticeInput = Partial<Omit<BillingNotice, 'kind'>> & { kind: BillingNotice['kind'] };
const D = 24 * H;

export type Status = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'GRACE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';
export interface Sub {
  tenant_id: string; status: Status; price_book_code: string; trial_ends_at: Date | null; trial_warned_at: Date | null; current_period_start: Date | null; current_period_end: Date | null;
  cancel_at_period_end: boolean; payment_method: { kind: 'CARD' | 'OFFLINE'; brand?: string; last4?: string; mandateId?: string } | null;
  coupon_code: string | null; coupon_invoices_left: number | null; pending_change: { plan: string; addons: { code: string; quantity: number }[]; requestedBy: string } | null;
  retry_count: number; next_retry_at: Date | null; past_due_since: Date | null; grace_ends_at: Date | null; suspended_at: Date | null; ended_at: Date | null;
  clock_offset_s: string; version: number;
}

/** First instant of the next calendar month (UTC): billing periods are calendar months. */
export const nextMonthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
const monthOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const label = (a: Date, b: Date) => `${fmt(a)} – ${fmt(new Date(b.getTime() - 1))}`;

/**
 * SaaS billing (Phase 19): one subscription per hospital, calendar-month periods billed in advance (usage in arrears),
 * invoices from the price book, charges on the saved card (or OFFLINE: sales-led hospitals pay by bank transfer),
 * the dunning lifecycle and its effects (subscription.status_changed → entitlement-service).
 */
@Injectable()
export class BillingService implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Billing');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(CONTROL_DB) private readonly db: pg.Pool,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource,
    @Inject(RECURRING_GATEWAY) private readonly gateway: RecurringGateway,
    private readonly plans: PlansService,
    private readonly usage: UsageService,
  ) {}

  async onModuleInit() {
    await withTx(this.db, (c) => seedPriceBooks(c, this.plans.modules));
  }

  onApplicationBootstrap() {
    // hospitals with a contract and no subscription (created before billing): sales-led, pay by invoice
    retryInBackground('SubscriptionBackfill', async () => {
      let n = 0;
      for (const t of await this.placements.list()) if (t.status === 'ACTIVE' && (await this.ensure(t.id))) n++;
      if (n) this.log.log(`opened ${n} subscription(s) for existing hospitals (offline payment)`);
    });
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => void this.tickAll().catch((e) => this.log.warn(`billing tick: ${(e as Error).message}`)), Number(process.env.BILLING_TICK_MS ?? 15_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  // ---------- subscriptions ----------

  /**
   * Open a subscription for a hospital that has a contract (internal plans: none). Self-serve signup: a free trial of
   * the plan version's length (no card yet). Sales-led: ACTIVE at once, paid by bank transfer.
   */
  async ensure(tenantId: string, opts: { signup?: boolean } = {}): Promise<boolean> {
    const cur = await this.plans.current(tenantId).catch(() => null);
    if (!cur || (await this.isInternal(cur))) return false;
    const { rows: [v] } = await this.db.query(`SELECT trial_days FROM plan_versions pv JOIN contracts c ON c.plan_version_id = pv.id WHERE c.tenant_id = $1 AND c.status = 'ACTIVE'`, [tenantId]);
    const trialDays = opts.signup ? Number(v?.trial_days ?? 0) : 0;
    return withTx(this.db, async (c) => {
      const { rows: [book] } = await c.query('SELECT code FROM price_books WHERE is_default');
      const now = new Date();
      const trial = trialDays > 0 ? new Date(now.getTime() + trialDays * D) : null;
      const { rowCount } = await c.query(`INSERT INTO subscriptions (tenant_id, status, price_book_code, trial_ends_at, current_period_start, current_period_end, payment_method)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, trial ? 'TRIALING' : 'ACTIVE', book.code, trial, trial ? null : now, trial ? null : nextMonthStart(now), trial ? null : (opts.signup ? null : { kind: 'OFFLINE' })]);
      if (rowCount) await this.publishStatus(c, await this.sub(c, tenantId, true));
      return !!rowCount;
    });
  }

  private async isInternal(cur: Contract) {
    const { rows: [p] } = await this.db.query('SELECT internal FROM plans WHERE code = $1', [cur.plan.code]);
    return !!p?.internal;
  }

  async sub(c: Queryable, tenantId: string, lock = false): Promise<Sub> {
    const { rows: [s] } = await c.query(`SELECT * FROM subscriptions WHERE tenant_id = $1 ${lock ? 'FOR UPDATE' : ''}`, [tenantId]);
    if (!s) throw new DomainError(404, 'NO_SUBSCRIPTION', 'this hospital has no MediCare subscription');
    return s as Sub;
  }

  /** "Now" on the hospital's billing clock (real time, plus a dev-only offset used by tests to jump ahead). */
  now(s: Sub) {
    return new Date(Date.now() + Number(s.clock_offset_s) * 1000);
  }

  private async update(c: Queryable, s: Sub, patch: Partial<Record<keyof Sub, unknown>>) {
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows: [n] } = await c.query(`UPDATE subscriptions SET ${sets}, version = version + 1, updated_at = now() WHERE tenant_id = $1 RETURNING *`, [s.tenant_id, ...keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v; })]);
    return n as Sub;
  }

  private async setStatus(c: Queryable, s: Sub, status: Status, patch: Partial<Record<keyof Sub, unknown>> = {}, notice?: NoticeInput) {
    const n = await this.update(c, s, { status, ...patch });
    if (s.status !== status) this.log.log(`${await this.plans.slug(s.tenant_id)}: subscription ${s.status} → ${status}`);
    await this.publishStatus(c, n);
    if (notice) await this.notice(c, n, notice);
    return n;
  }

  private async publishStatus(c: Queryable, s: Sub) {
    const data: SubscriptionStatusChanged = { status: s.status, seq: s.version + 1, trialEndsAt: s.trial_ends_at?.toISOString() ?? null, graceEndsAt: s.grace_ends_at?.toISOString() ?? null, periodEnd: s.current_period_end?.toISOString() ?? null };
    await addToOutbox(c, Topics.subscription, s.tenant_id, envelope(EventTypes.subscriptionStatusChanged, data, { tenantId: s.tenant_id }));
  }

  async notice(c: Queryable, s: Sub, n: NoticeInput) {
    const data: BillingNotice = { invoiceNo: n.invoiceNo ?? null, amount: n.amount ?? null, date: n.date ?? null, feature: n.feature ?? null, used: n.used ?? null, limit: n.limit ?? null, kind: n.kind, dedupe: n.dedupe ?? `${n.kind}:${randomUUID()}` };
    await addToOutbox(c, Topics.subscription, s.tenant_id, envelope(EventTypes.billingNotice, data, { tenantId: s.tenant_id }));
  }

  // ---------- pricing ----------

  private async quantities(tenantId: string) {
    const get = async (svc: string, path: string, key: string) => {
      const res = await fetch(`${process.env[`SVC_URL_${svc}`] ?? ''}/internal/tenants/${tenantId}/${path}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`${svc.toLowerCase()}-service ${res.status}`);
      return Number(((await res.json()) as Record<string, number>)[key] ?? 0);
    };
    const [doctor, branch] = await Promise.all([get('PROVIDER', 'doctor-count', 'doctors'), get('TENANT', 'branch-count', 'branches')]);
    return { doctor, branch };
  }

  /** The price inputs for a contract (plan components from the price book, add-ons at their list price). */
  private async priced(c: Queryable, book: PriceBook, contract: Pick<Contract, 'plan' | 'addons'>) {
    const addonPrices = new Map((await this.plans.addonList(c)).map((a) => [a.code, a.listPrice]));
    return {
      plan: { code: contract.plan.code, name: contract.plan.name, listPrice: contract.plan.listPrice, components: book.plans.get(contract.plan.code) ?? [] },
      addons: contract.addons.map((a) => ({ code: a.code, name: a.name, quantity: a.quantity, listPrice: addonPrices.get(a.code) ?? 0 })),
    };
  }

  /** Published plans priced for this hospital (its doctors and branches), for the plan picker. */
  async comparePlans(tenantId: string) {
    const s = await this.sub(this.db, tenantId);
    const book = await loadPriceBook(this.db, s.price_book_code);
    const q = await this.quantities(tenantId);
    const cur = await this.plans.current(tenantId);
    const names = new Map([...this.plans.modules.modules.values()].map((m) => [m.key, m.name]));
    const out = [];
    for (const p of await this.plans.plans()) {
      const priced = await this.priced(this.db, book, { plan: { ...cur.plan, code: p.code, name: p.name, listPrice: p.listPrice }, addons: [] });
      out.push({ code: p.code, name: p.name, edition: p.editionName, tier: p.tier, listPrice: p.listPrice, monthly: monthlyTotal({ ...priced, quantities: q }), current: p.code === cur.plan.code,
        modules: p.modules.filter((m) => m !== 'core').map((m) => names.get(m) ?? m), features: p.features, addons: p.addonCodes });
    }
    return { quantities: q, gstPercent: book.gstPercent, plans: out };
  }

  /** Monthly estimate for a contract (account zone: "your next invoice", plan comparison). */
  async estimate(tenantId: string, contract?: Pick<Contract, 'plan' | 'addons'>) {
    const s = await this.sub(this.db, tenantId);
    const book = await loadPriceBook(this.db, s.price_book_code);
    const q = await this.quantities(tenantId);
    const cur = contract ?? (await this.plans.current(tenantId));
    const inv = calculate({ ...(await this.priced(this.db, book, cur)), quantities: q, fraction: 1, periodLabel: '', gstPercent: book.gstPercent });
    return { quantities: q, ...inv };
  }

  /** Flushed usage counters not yet billed, for months before `before` (usage is billed in arrears). */
  private async unbilledUsage(c: Queryable, tenantId: string, before: Date, book: PriceBook, contract: Contract): Promise<{ inputs: UsageInput[]; keys: { feature: string; month: Date }[] }> {
    const { rows } = await c.query(`SELECT feature_key, month, to_char(month, 'YYYY-MM') AS ym, used FROM usage_counters WHERE tenant_id = $1 AND month < $2 AND billed_invoice_id IS NULL ORDER BY month`, [tenantId, before]);
    const names = new Map([...this.plans.modules.modules.values()].flatMap((m) => m.features.map((f) => [f.key, f] as const)));
    const inputs = rows.map((r) => {
      const eff = contract.effective.features[r.feature_key];
      const f = names.get(r.feature_key);
      return { key: r.feature_key, name: `${f?.name ?? r.feature_key} in ${new Date(`${r.ym}-15T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`, unit: f?.unit ?? '', used: Number(r.used), limit: eff?.limit ?? null, overage: eff?.overage ?? null, unitPrice: book.usage.get(r.feature_key) ?? 0 };
    });
    return { inputs, keys: rows.map((r) => ({ feature: r.feature_key, month: r.month })) };
  }

  /** Create an invoice (OPEN) for a period; applies the coupon and marks usage as billed. */
  private async invoice(c: Queryable, s: Sub, kind: 'FIRST' | 'RENEWAL' | 'PRORATION', start: Date, end: Date, fraction: number, extra: { credits?: ChargeInput['credits']; contract?: Contract; withUsage?: boolean } = {}) {
    const book = await loadPriceBook(c, s.price_book_code);
    const contract = extra.contract ?? (await this.plans.current(s.tenant_id, c));
    const usage = extra.withUsage ? await this.unbilledUsage(c, s.tenant_id, monthOf(start), book, contract) : { inputs: [], keys: [] };
    const { rows: [cp] } = s.coupon_code && (s.coupon_invoices_left ?? 1) > 0 && kind !== 'PRORATION' ? await c.query('SELECT * FROM coupons WHERE code = $1', [s.coupon_code]) : { rows: [] };
    const inv: Invoice = calculate({
      ...(await this.priced(c, book, contract)), quantities: await this.quantities(s.tenant_id), fraction, periodLabel: label(start, end),
      usage: usage.inputs, credits: extra.credits, gstPercent: book.gstPercent,
      coupon: cp ? { code: cp.code, percentOff: cp.percent_off == null ? null : Number(cp.percent_off), amountOff: cp.amount_off == null ? null : Number(cp.amount_off) } : null,
    });
    const id = randomUUID();
    const { rows: [no] } = await c.query(`SELECT nextval('saas_invoice_no') n`);
    const number = `MC-${start.getUTCFullYear()}-${String(no.n).padStart(6, '0')}`;
    await c.query(`INSERT INTO saas_invoices (id, number, tenant_id, kind, period_start, period_end, status, currency, subtotal, discount, gst, total, details, issued_at)
      VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$9,$10,$11,$12,$13)`,
      [id, number, s.tenant_id, kind, start, end, book.currency, inv.subtotal, inv.discount, inv.gst, inv.total, JSON.stringify({ ...inv, plan: { code: contract.plan.code, name: contract.plan.name, version: contract.plan.version }, priceBook: book.code }), this.now(s)]);
    for (const k of usage.keys) await c.query('UPDATE usage_counters SET billed_invoice_id = $4 WHERE tenant_id = $1 AND feature_key = $2 AND month = $3', [s.tenant_id, k.feature, k.month, id]);
    if (cp) await c.query('UPDATE subscriptions SET coupon_invoices_left = CASE WHEN coupon_invoices_left IS NULL THEN NULL ELSE coupon_invoices_left - 1 END WHERE tenant_id = $1', [s.tenant_id]);
    return { id, number, total: inv.total };
  }

  /** Charge an invoice on the saved card. OFFLINE subscriptions: the invoice waits for a bank transfer. */
  private async charge(c: Queryable, s: Sub, inv: { id: string; number: string; total: number }) {
    if (s.payment_method?.kind !== 'CARD' || !s.payment_method.mandateId) return { ok: false, offline: true, error: null as string | null };
    if (inv.total <= 0) {
      await c.query(`UPDATE saas_invoices SET status = 'PAID', paid_at = $2 WHERE id = $1`, [inv.id, this.now(s)]);
      return { ok: true, offline: false, error: null };
    }
    const r = await this.gateway.charge(s.payment_method.mandateId, Math.round(inv.total * 100), inv.number);
    await c.query(`UPDATE saas_invoices SET status = $2, attempts = attempts + 1, last_error = $3, payment_id = $4, paid_at = CASE WHEN $2 = 'PAID' THEN $5::timestamptz END WHERE id = $1`,
      [inv.id, r.ok ? 'PAID' : 'FAILED', r.error, r.paymentId, this.now(s)]);
    return { ok: r.ok, offline: false, error: r.error };
  }

  // ---------- the lifecycle ----------

  async tickAll() {
    if (this.running) return 0;
    this.running = true;
    try {
      const { rows } = await this.db.query(`SELECT tenant_id FROM subscriptions s WHERE status NOT IN ('CANCELLED','EXPIRED') AND (
          (status = 'TRIALING' AND (trial_ends_at <= now() + make_interval(secs => clock_offset_s)
             OR (trial_warned_at IS NULL AND trial_ends_at - interval '${DUNNING.trialWarningDays} days' <= now() + make_interval(secs => clock_offset_s))))
          OR (status IN ('ACTIVE','PAST_DUE','GRACE') AND current_period_end <= now() + make_interval(secs => clock_offset_s))
          OR (status = 'PAST_DUE' AND next_retry_at <= now() + make_interval(secs => clock_offset_s))
          OR (status = 'GRACE' AND grace_ends_at <= now() + make_interval(secs => clock_offset_s))
          OR (status = 'SUSPENDED' AND suspended_at + interval '${DUNNING.cancelAfterSuspendedDays} days' <= now() + make_interval(secs => clock_offset_s)))`);
      for (const r of rows) await this.tick(r.tenant_id).catch((e) => this.log.warn(`${r.tenant_id}: ${(e as Error).message}`));
      return rows.length;
    } finally {
      this.running = false;
    }
  }

  /** Everything due for one hospital at its billing-clock "now" (renewals may run several months if the clock jumped). */
  async tick(tenantId: string) {
    await this.usage.flush(tenantId); // invoices bill usage from the database
    for (let guard = 0; guard < 24; guard++) {
      const moved = await withTx(this.db, async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing:${tenantId}`]);
        return this.step(c, await this.sub(c, tenantId, true));
      });
      if (!moved) return;
    }
  }

  /** One transition; returns false when nothing (more) is due. */
  private async step(c: Queryable, s: Sub): Promise<boolean> {
    const now = this.now(s);
    switch (s.status) {
      case 'TRIALING': {
        if (!s.trial_ends_at) return false;
        if (now < s.trial_ends_at) {
          if (!s.trial_warned_at && now.getTime() >= s.trial_ends_at.getTime() - DUNNING.trialWarningDays * D) {
            await this.update(c, s, { trial_warned_at: now });
            await this.notice(c, s, { kind: 'TRIAL_ENDING', date: s.trial_ends_at.toISOString(), dedupe: `trial-ending:${s.trial_ends_at.toISOString()}` });
          }
          return false;
        }
        if (s.payment_method?.kind !== 'CARD') {
          await this.setStatus(c, s, 'EXPIRED', { ended_at: now });
          return false;
        }
        // trial → paid: the rest of this month, prorated, then calendar months
        const start = s.trial_ends_at;
        const end = nextMonthStart(start);
        const inv = await this.invoice(c, s, 'FIRST', start, end, remainingFraction(start, monthOf(start), end));
        const paid = await this.charge(c, s, inv);
        const n = await this.update(c, s, { current_period_start: start, current_period_end: end });
        if (paid.ok) await this.setStatus(c, n, 'ACTIVE', {}, { kind: 'TRIAL_CONVERTED', invoiceNo: inv.number, amount: inv.total });
        else await this.failed(c, n, inv, paid.error, now);
        return true;
      }
      case 'ACTIVE':
      case 'PAST_DUE':
      case 'GRACE': {
        if (s.current_period_end && now >= s.current_period_end) return this.renew(c, s, now);
        if (s.status === 'PAST_DUE' && s.next_retry_at && now >= s.next_retry_at) return this.retry(c, s, now);
        if (s.status === 'GRACE' && s.grace_ends_at && now >= s.grace_ends_at) {
          await this.setStatus(c, s, 'SUSPENDED', { suspended_at: now }, { kind: 'SUSPENDED', date: now.toISOString() });
          return true;
        }
        return false;
      }
      case 'SUSPENDED':
        if (s.suspended_at && now.getTime() >= s.suspended_at.getTime() + DUNNING.cancelAfterSuspendedDays * D) {
          await this.setStatus(c, s, 'CANCELLED', { ended_at: now });
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  /** Period end: scheduled downgrade, cancellation, or the next month's invoice (+ last month's usage) and its charge. */
  private async renew(c: Queryable, s: Sub, now: Date): Promise<boolean> {
    const start = s.current_period_end!;
    if (s.cancel_at_period_end) {
      await this.setStatus(c, s, 'CANCELLED', { ended_at: start });
      return true;
    }
    if (s.pending_change) {
      await this.plans.change(s.tenant_id, { plan: s.pending_change.plan, addons: s.pending_change.addons, by: s.pending_change.requestedBy, reason: 'scheduled change at the end of the billing period' });
      s = await this.update(c, s, { pending_change: null });
    }
    const end = nextMonthStart(start);
    const inv = await this.invoice(c, s, 'RENEWAL', start, end, 1, { withUsage: true });
    const n = await this.update(c, s, { current_period_start: start, current_period_end: end });
    const paid = await this.charge(c, n, inv);
    if (paid.offline || paid.ok) return true; // offline: waits for a bank transfer; status unchanged
    await this.failed(c, n, inv, paid.error, now);
    return true;
  }

  private async failed(c: Queryable, s: Sub, inv: { number: string; total: number }, error: string | null, now: Date) {
    if (s.status === 'PAST_DUE' || s.status === 'GRACE') return; // already in dunning: the retries cover it
    await this.setStatus(c, s, 'PAST_DUE', { past_due_since: now, retry_count: 0, next_retry_at: new Date(now.getTime() + DUNNING.retryEveryH * H) },
      { kind: 'PAYMENT_FAILED', invoiceNo: inv.number, amount: inv.total, date: new Date(now.getTime() + DUNNING.retryEveryH * H).toISOString(), dedupe: `failed:${inv.number}` });
    void error;
  }

  /** Retry every unpaid invoice on the saved card; after the last retry, the grace period starts. */
  private async retry(c: Queryable, s: Sub, now: Date): Promise<boolean> {
    if (await this.collect(c, s)) return true;
    const count = s.retry_count + 1;
    if (count >= DUNNING.retries) {
      const graceEnds = new Date(now.getTime() + DUNNING.graceDays * D);
      await this.setStatus(c, s, 'GRACE', { retry_count: count, next_retry_at: null, grace_ends_at: graceEnds }, { kind: 'GRACE_STARTED', date: graceEnds.toISOString(), dedupe: `grace:${s.past_due_since?.toISOString()}` });
    } else {
      await this.update(c, s, { retry_count: count, next_retry_at: new Date(now.getTime() + DUNNING.retryEveryH * H) });
    }
    return true;
  }

  /** Charge every FAILED/OPEN invoice; when all are paid, the subscription is ACTIVE again. Returns true if paid up. */
  private async collect(c: Queryable, s: Sub): Promise<boolean> {
    const { rows } = await c.query(`SELECT id, number, total FROM saas_invoices WHERE tenant_id = $1 AND status IN ('FAILED','OPEN') ORDER BY issued_at FOR UPDATE`, [s.tenant_id]);
    let paidTotal = 0;
    for (const inv of rows) {
      const r = await this.charge(c, s, { id: inv.id, number: inv.number, total: Number(inv.total) });
      if (!r.ok) return false;
      paidTotal += Number(inv.total);
    }
    if (['PAST_DUE', 'GRACE', 'SUSPENDED'].includes(s.status)) {
      await this.setStatus(c, s, 'ACTIVE', { retry_count: 0, next_retry_at: null, past_due_since: null, grace_ends_at: null, suspended_at: null },
        { kind: 'PAYMENT_RECEIVED', amount: Math.round(paidTotal * 100) / 100, invoiceNo: rows.at(-1)?.number ?? null });
    }
    return true;
  }

  // ---------- the hospital's own actions (account zone) ----------

  async summary(tenantId: string) {
    const s = await this.sub(this.db, tenantId);
    const contract = await this.plans.current(tenantId);
    const estimate = await this.estimate(tenantId, contract).catch(() => null);
    const { rows: [due] } = await this.db.query(`SELECT count(*)::int n, coalesce(sum(total), 0) total FROM saas_invoices WHERE tenant_id = $1 AND status IN ('FAILED','OPEN')`, [tenantId]);
    return {
      status: s.status, now: this.now(s), trialEndsAt: s.trial_ends_at, periodStart: s.current_period_start, periodEnd: s.current_period_end,
      cardPayments: this.gateway.takesCards, cancelAtPeriodEnd: s.cancel_at_period_end, paymentMethod: s.payment_method ? { kind: s.payment_method.kind, brand: s.payment_method.brand ?? null, last4: s.payment_method.last4 ?? null } : null,
      coupon: s.coupon_code ? { code: s.coupon_code, invoicesLeft: s.coupon_invoices_left } : null, pendingChange: s.pending_change,
      pastDueSince: s.past_due_since, nextRetryAt: s.next_retry_at, graceEndsAt: s.grace_ends_at, suspendedAt: s.suspended_at,
      unpaid: { invoices: due.n, total: Number(due.total) },
      plan: { code: contract.plan.code, name: contract.plan.name, version: contract.plan.version }, addons: contract.addons, estimate,
      clockOffsetDays: Math.round(Number(s.clock_offset_s) / 86400 * 10) / 10,
    };
  }

  /**
   * Add a card: a session on the gateway's hosted page (card details never reach MediCare, review B-6). The customer
   * comes back to `returnUrl`, which must be on one of the hospital's own hosts (no open redirect).
   */
  async startCardSession(tenantId: string, returnUrl: string, by: string) {
    if (!this.gateway.takesCards) throw new DomainError(422, 'CARDS_NOT_AVAILABLE', 'card payments are not set up yet: MediCare sends invoices and you pay by bank transfer');
    const t = await this.placements.get(tenantId);
    const host = new URL(returnUrl).hostname;
    if (!t.hosts.includes(host)) throw new DomainError(422, 'BAD_RETURN_URL', 'the return address must be on the hospital\'s own site');
    const id = randomUUID();
    await this.db.query(`INSERT INTO card_sessions (id, tenant_id, gateway, status, created_by, expires_at) VALUES ($1,$2,$3,'PENDING',$4, now() + interval '30 minutes')`, [id, tenantId, this.gateway.name, by]);
    const sep = returnUrl.includes('?') ? '&' : '?';
    const { url } = await this.gateway.startMandate({ sessionId: id, returnUrl: `${returnUrl}${sep}session=${id}`, hospital: t.name });
    return { sessionId: id, url };
  }

  /** Back from the gateway: what was authorised is asked of the gateway; then unpaid invoices are charged (a suspended hospital pays this way). */
  async completeCardSession(tenantId: string, sessionId: string, by: string) {
    const { rows: [cs] } = await this.db.query('SELECT * FROM card_sessions WHERE id = $1 AND tenant_id = $2', [sessionId, tenantId]);
    if (!cs) throw new DomainError(404, 'NOT_FOUND', 'card session not found');
    if (cs.status !== 'PENDING') throw new DomainError(409, 'SESSION_USED', 'this card was already saved; start again to change it');
    if (new Date(cs.expires_at).getTime() < Date.now()) throw new DomainError(410, 'SESSION_EXPIRED', 'the card page timed out: try again');
    let mandate: Mandate;
    try {
      mandate = await this.gateway.completeMandate(sessionId);
    } catch (e) {
      await this.db.query(`UPDATE card_sessions SET status = 'FAILED', error = $2, completed_at = now() WHERE id = $1`, [sessionId, (e as Error).message]);
      throw new DomainError(422, 'CARD_REFUSED', (e as Error).message);
    }
    return withTx(this.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing:${tenantId}`]);
      const { rowCount } = await c.query(`UPDATE card_sessions SET status = 'DONE', completed_at = now() WHERE id = $1 AND status = 'PENDING'`, [sessionId]);
      if (!rowCount) throw new DomainError(409, 'SESSION_USED', 'this card was already saved');
      const s = await this.update(c, await this.sub(c, tenantId, true), { payment_method: { kind: 'CARD', brand: mandate.brand, last4: mandate.last4, mandateId: mandate.mandateId } });
      await this.plans.audit(c, by, 'PAYMENT_METHOD_SAVED', 'TENANT', tenantId, await this.plans.slug(tenantId), null, { brand: mandate.brand, last4: mandate.last4 });
      const { rows: [due] } = await c.query(`SELECT count(*)::int n FROM saas_invoices WHERE tenant_id = $1 AND status IN ('FAILED','OPEN')`, [tenantId]);
      const paidUp = s.status === 'TRIALING' ? true : await this.collect(c, s);
      return { brand: mandate.brand, last4: mandate.last4, paidUp, hadUnpaid: due.n > 0 };
    });
  }

  async payNow(tenantId: string, by: string) {
    return withTx(this.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing:${tenantId}`]);
      const s = await this.sub(c, tenantId, true);
      if (s.payment_method?.kind !== 'CARD') throw new DomainError(422, 'NO_CARD', 'add a card first');
      const ok = await this.collect(c, s);
      await this.plans.audit(c, by, ok ? 'INVOICES_PAID' : 'PAYMENT_DECLINED', 'TENANT', tenantId, await this.plans.slug(tenantId), null, null);
      if (!ok) throw new DomainError(402, 'PAYMENT_DECLINED', 'the card was declined: use another card');
      return { paid: true };
    });
  }

  async applyCoupon(tenantId: string, code: string, by: string) {
    return withTx(this.db, async (c) => {
      const s = await this.sub(c, tenantId, true);
      const { rows: [cp] } = await c.query('SELECT * FROM coupons WHERE code = $1 FOR UPDATE', [code.toUpperCase()]);
      if (!cp || !cp.active || (cp.valid_until && new Date(cp.valid_until) < this.now(s))) throw new DomainError(422, 'COUPON_INVALID', 'this coupon is not valid');
      if (cp.max_redemptions != null && cp.redeemed >= cp.max_redemptions) throw new DomainError(422, 'COUPON_USED_UP', 'this coupon has been used up');
      if (s.coupon_code) throw new DomainError(409, 'COUPON_EXISTS', `coupon ${s.coupon_code} is already applied`);
      await c.query('UPDATE coupons SET redeemed = redeemed + 1 WHERE code = $1', [cp.code]);
      await this.update(c, s, { coupon_code: cp.code, coupon_invoices_left: cp.months });
      await this.plans.audit(c, by, 'COUPON_APPLIED', 'TENANT', tenantId, await this.plans.slug(tenantId), null, { coupon: cp.code });
      return { code: cp.code, description: cp.description, invoices: cp.months };
    });
  }

  /**
   * Self-serve plan change: an upgrade (dearer per month) applies now, with a prorated invoice charged at once (if the
   * charge fails nothing changes); a downgrade waits for the end of the billing period (nothing is cut mid-month).
   */
  async changePlan(tenantId: string, input: { plan: string; addons: { code: string; quantity?: number }[] }, by: string) {
    const s0 = await this.sub(this.db, tenantId);
    if (['SUSPENDED', 'CANCELLED', 'EXPIRED'].includes(s0.status)) throw new DomainError(409, 'SUBSCRIPTION_INACTIVE', 'pay the open invoices first');
    const cur = await this.plans.current(tenantId);
    const target = (await this.plans.plans()).find((p) => p.code === input.plan);
    if (!target) throw new DomainError(404, 'UNKNOWN_PLAN', `no plan ${input.plan}`);
    const addonList = await this.plans.addonList();
    const addons = input.addons.map((a) => ({ code: a.code, quantity: a.quantity ?? 1, name: addonList.find((x) => x.code === a.code)?.name ?? a.code }));
    const book = await loadPriceBook(this.db, s0.price_book_code);
    const q = await this.quantities(tenantId);
    const before = monthlyTotal({ ...(await this.priced(this.db, book, cur)), quantities: q });
    const after = monthlyTotal({ ...(await this.priced(this.db, book, { plan: { ...cur.plan, code: target.code, name: target.name, listPrice: target.listPrice }, addons: addons as Contract['addons'] })), quantities: q });
    const sim = await this.plans.simulate(tenantId, (await this.db.query(`SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.code = $1 AND v.status = 'PUBLISHED' ORDER BY v.version DESC LIMIT 1`, [target.code])).rows[0].id, input.addons);
    if (sim.problems.length) throw new DomainError(422, 'PLAN_CHANGE_INVALID', sim.problems.join('; '), { problems: sim.problems });

    if (after <= before || s0.status === 'TRIALING') {
      if (s0.status === 'TRIALING') {
        // during the trial anything goes, at once (nothing billed yet)
        await this.plans.change(tenantId, { plan: target.code, addons: input.addons, by, reason: 'changed during the trial' });
        return { applied: 'NOW', monthly: { before, after } };
      }
      await withTx(this.db, async (c) => {
        const s = await this.sub(c, tenantId, true);
        await this.update(c, s, { pending_change: { plan: target.code, addons: addons.map((a) => ({ code: a.code, quantity: a.quantity })), requestedBy: by } });
        await this.plans.audit(c, by, 'DOWNGRADE_SCHEDULED', 'TENANT', tenantId, await this.plans.slug(tenantId), { plan: cur.plan.code }, { plan: target.code, at: s.current_period_end }, null);
      });
      return { applied: 'AT_PERIOD_END', at: s0.current_period_end, monthly: { before, after } };
    }

    return withTx(this.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing:${tenantId}`]);
      const s = await this.sub(c, tenantId, true);
      const now = this.now(s);
      const f = remainingFraction(now, s.current_period_start!, s.current_period_end!);
      const newContract = { ...cur, plan: { ...cur.plan, code: target.code, name: target.name, listPrice: target.listPrice }, addons: addons as Contract['addons'] };
      const inv = await this.invoice(c, s, 'PRORATION', now, s.current_period_end!, f, { contract: newContract as Contract, credits: [{ description: `Unused ${cur.plan.name} (${label(now, s.current_period_end!)})`, amount: Math.round(before * f * 100) / 100 }] });
      const paid = await this.charge(c, s, inv);
      if (!paid.ok && !paid.offline) throw new DomainError(402, 'PAYMENT_DECLINED', `the upgrade was not made: ${paid.error}`);
      await this.plans.change(tenantId, { plan: target.code, addons: input.addons, by, reason: `upgrade (prorated invoice ${inv.number})` });
      if (s.pending_change) await this.update(c, s, { pending_change: null });
      return { applied: 'NOW', invoice: inv, monthly: { before, after } };
    });
  }

  async cancel(tenantId: string, cancel: boolean, by: string) {
    return withTx(this.db, async (c) => {
      const s = await this.sub(c, tenantId, true);
      if (cancel && s.status !== 'ACTIVE') throw new DomainError(409, 'NOT_CANCELLABLE', s.status === 'TRIALING' ? 'a trial without a card simply ends; nothing to cancel' : `a ${s.status.toLowerCase()} subscription cannot be cancelled here`);
      await this.update(c, s, { cancel_at_period_end: cancel });
      await this.plans.audit(c, by, cancel ? 'CANCEL_SCHEDULED' : 'CANCEL_UNDONE', 'TENANT', tenantId, await this.plans.slug(tenantId), null, { at: s.current_period_end });
      return { cancelAtPeriodEnd: cancel, at: s.current_period_end };
    });
  }

  async invoices(tenantId: string) {
    const { rows } = await this.db.query(`SELECT id, number, kind, period_start, period_end, status, currency, subtotal, discount, gst, total, attempts, last_error, issued_at, paid_at FROM saas_invoices WHERE tenant_id = $1 ORDER BY issued_at DESC, number DESC`, [tenantId]);
    return rows.map((r) => ({ id: r.id, number: r.number, kind: r.kind, periodStart: r.period_start, periodEnd: r.period_end, status: r.status, currency: r.currency, subtotal: Number(r.subtotal), discount: Number(r.discount), gst: Number(r.gst), total: Number(r.total), attempts: r.attempts, lastError: r.last_error, issuedAt: r.issued_at, paidAt: r.paid_at }));
  }

  async invoiceDetail(tenantId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError(404, 'NOT_FOUND', 'invoice not found');
    const { rows: [r] } = await this.db.query('SELECT * FROM saas_invoices WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (!r) throw new DomainError(404, 'NOT_FOUND', 'invoice not found');
    return { id: r.id, number: r.number, kind: r.kind, periodStart: r.period_start, periodEnd: r.period_end, status: r.status, currency: r.currency, total: Number(r.total), issuedAt: r.issued_at, paidAt: r.paid_at, lastError: r.last_error, ...r.details };
  }

  /** Support: a bank transfer arrived for an OFFLINE invoice. */
  async recordOfflinePayment(tenantId: string, invoiceId: string, reference: string, by: string) {
    return withTx(this.db, async (c) => {
      const s = await this.sub(c, tenantId, true);
      const { rowCount } = await c.query(`UPDATE saas_invoices SET status = 'PAID', paid_at = $3, payment_id = $4 WHERE id = $1 AND tenant_id = $2 AND status IN ('OPEN','FAILED')`, [invoiceId, tenantId, this.now(s), `offline:${reference}`]);
      if (!rowCount) throw new DomainError(404, 'NOT_FOUND', 'no unpaid invoice with that id');
      await this.plans.audit(c, by, 'OFFLINE_PAYMENT', 'TENANT', tenantId, await this.plans.slug(tenantId), null, { invoiceId, reference });
      const { rows: [left] } = await c.query(`SELECT count(*)::int n FROM saas_invoices WHERE tenant_id = $1 AND status IN ('OPEN','FAILED')`, [tenantId]);
      if (!left.n && ['PAST_DUE', 'GRACE', 'SUSPENDED'].includes(s.status)) await this.setStatus(c, s, 'ACTIVE', { retry_count: 0, next_retry_at: null, past_due_since: null, grace_ends_at: null, suspended_at: null });
      return { paid: true };
    });
  }

  /** The hospital was deleted: end the subscription now (no further invoices). */
  async close(tenantId: string) {
    await withTx(this.db, async (c) => {
      const { rows: [s] } = await c.query('SELECT * FROM subscriptions WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
      if (!s || s.status === 'CANCELLED') return;
      await this.setStatus(c, s as Sub, 'CANCELLED', { ended_at: new Date() });
    });
  }

  // ---------- console ----------

  async priceBooks() {
    const { rows: books } = await this.db.query('SELECT code, name, currency, gst_percent, is_default FROM price_books ORDER BY is_default DESC, code');
    const { rows: comps } = await this.db.query('SELECT price_book_code, plan_code, feature_key, model, unit, amount, included, tiers FROM price_components ORDER BY id');
    const { rows: coupons } = await this.db.query('SELECT code, description, percent_off, amount_off, months, max_redemptions, redeemed, valid_until, active, created_by FROM coupons ORDER BY code');
    return {
      books: books.map((b) => ({ code: b.code, name: b.name, currency: b.currency, gstPercent: Number(b.gst_percent), default: b.is_default,
        components: comps.filter((x) => x.price_book_code === b.code).map((x) => ({ plan: x.plan_code, feature: x.feature_key, model: x.model, unit: x.unit, amount: x.amount == null ? null : Number(x.amount), included: x.included, tiers: x.tiers })) })),
      addons: await this.plans.addonList(),
      coupons: coupons.map((x) => ({ code: x.code, description: x.description, percentOff: x.percent_off == null ? null : Number(x.percent_off), amountOff: x.amount_off == null ? null : Number(x.amount_off), months: x.months, maxRedemptions: x.max_redemptions, redeemed: x.redeemed, validUntil: x.valid_until, active: x.active, createdBy: x.created_by })),
    };
  }

  async createCoupon(by: string, cp: { code: string; description: string; percentOff?: number | null; amountOff?: number | null; months?: number | null; maxRedemptions?: number | null; validUntil?: string | null }) {
    return withTx(this.db, async (c) => {
      const { rowCount } = await c.query(`INSERT INTO coupons (code, description, percent_off, amount_off, months, max_redemptions, valid_until, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [cp.code, cp.description, cp.percentOff ?? null, cp.amountOff ?? null, cp.months ?? null, cp.maxRedemptions ?? null, cp.validUntil ?? null, by]);
      if (!rowCount) throw new DomainError(409, 'COUPON_EXISTS', `coupon ${cp.code} already exists`);
      await this.plans.audit(c, by, 'COUPON_CREATED', 'PLAN', cp.code, cp.code, null, cp);
      return cp;
    });
  }

  /** Support view of one hospital's billing (null: no subscription, e.g. MediCare's own account). */
  async hospitalBilling(tenantId: string) {
    const summary = await this.summary(tenantId).catch((e) => { if ((e as DomainError).code === 'NO_SUBSCRIPTION') return null; throw e; });
    return summary ? { ...summary, invoices: await this.invoices(tenantId) } : null;
  }

  // ---------- dev only: the billing clock ----------

  private devOnly() {
    if (!isDev()) throw new DomainError(404, 'NOT_FOUND', 'not found');
  }

  /** Start a fresh trial (tests): no card, no coupon, no invoices, no usage, clock back to real time. */
  async resetTrial(tenantId: string, days: number) {
    this.devOnly();
    await this.usage.clear(tenantId);
    await withTx(this.db, async (c) => {
      const s = await this.sub(c, tenantId, true);
      // a test reset: the hospital's invoice history goes too (dev only; usage counters were cleared above)
      await c.query('DELETE FROM saas_invoices WHERE tenant_id = $1', [tenantId]);
      await this.setStatus(c, s, 'TRIALING', { trial_ends_at: new Date(Date.now() + days * D), trial_warned_at: null, current_period_start: null, current_period_end: null, payment_method: null, coupon_code: null, coupon_invoices_left: null, pending_change: null,
        retry_count: 0, next_retry_at: null, past_due_since: null, grace_ends_at: null, suspended_at: null, ended_at: null, cancel_at_period_end: false, clock_offset_s: 0 });
    });
  }

  /** Move a hospital's billing clock to the next due moment (or +N days) and run what is due. */
  async advance(tenantId: string, to: string) {
    this.devOnly();
    const s = await this.sub(this.db, tenantId);
    const now = this.now(s);
    const target = to === 'trial-end' ? s.trial_ends_at : to === 'period-end' ? s.current_period_end : to === 'next-retry' ? s.next_retry_at : to === 'grace-end' ? s.grace_ends_at
      : /^\+\d+d$/.test(to) ? new Date(now.getTime() + Number(to.slice(1, -1)) * D) : null;
    if (!target) throw new DomainError(422, 'NOTHING_DUE', `no ${to} for a ${s.status} subscription`);
    const offset = Math.max(Number(s.clock_offset_s), Math.ceil((target.getTime() - Date.now()) / 1000) + 1);
    await this.db.query('UPDATE subscriptions SET clock_offset_s = $2 WHERE tenant_id = $1', [tenantId, offset]);
    await this.tick(tenantId);
    return this.summary(tenantId);
  }
}
