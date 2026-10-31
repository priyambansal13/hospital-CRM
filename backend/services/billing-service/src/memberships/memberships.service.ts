import { Injectable, Logger } from '@nestjs/common';
import { EventTypes, type MembershipBenefits, type MembershipChanged, type PaymentSucceeded, Topics } from '@mc/contracts';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { conflict, DomainError, notFound } from '@mc/nest-common';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { BillingService } from '../billing/billing.service.js';

/** The template a hospital starts from (FEATURES-AND-PLANS.md §3.2); it edits names, prices and benefits. */
export const TEMPLATE: { code: string; name: string; description: string; price: number; period: 'MONTHLY' | 'YEARLY'; benefits: MembershipBenefits }[] = [
  { code: 'CARE_PLUS', name: 'Care+', description: 'For you: book further ahead, member-only times, video consults and lab savings.', price: 499, period: 'MONTHLY',
    benefits: { bookingWindowDays: 30, priorityAccess: true, freeVideoConsultsPerMonth: 2, labDiscountPct: 15, freeHomeCollection: true, familyMembers: 2 } },
  { code: 'FAMILY_PLUS', name: 'Family+', description: 'For the whole family: everything in Care+ for up to 6 people, with a bigger lab discount.', price: 999, period: 'MONTHLY',
    benefits: { bookingWindowDays: 30, priorityAccess: true, freeVideoConsultsPerMonth: 4, labDiscountPct: 20, freeHomeCollection: true, familyMembers: 6 } },
];

export interface PlanInput { code: string; name: string; description: string | null; price: number; period: 'MONTHLY' | 'YEARLY'; benefits: MembershipBenefits; active: boolean; sort: number }
const PAY_WITHIN_MIN = 30;

export const toPlan = (r: any) => ({ id: r.id, code: r.code, name: r.name, description: r.description, price: Number(r.price), period: r.period, benefits: r.benefits as MembershipBenefits, active: r.active, sort: r.sort, version: r.version });
const toMembership = (r: any) => ({
  id: r.id, status: r.status === 'ACTIVE' && new Date(r.ends_at).getTime() < Date.now() ? 'EXPIRED' : r.status, plan: r.plan_snapshot as { code: string; name: string; price: number; period: string; benefits: MembershipBenefits },
  patientName: r.patient_name, startsAt: r.starts_at, endsAt: r.ends_at, invoiceId: r.invoice_id, createdAt: r.created_at,
});

/**
 * Patient memberships (IMPLEMENTATION-PLAN.md Phase 26). A hospital defines its tiers; an account (the phone owner)
 * buys one with an online invoice to the hospital's connected account; once paid it is active for a month or a year.
 * Benefits are applied by the services they concern, which ask `benefitsFor` (internal endpoint).
 */
@Injectable()
export class MembershipsService {
  private readonly log = new Logger('Memberships');
  constructor(private readonly db: TenantDbRouter, private readonly billing: BillingService, private readonly entitlements: EntitlementsClient) {}

  /** Module switched on: the template tiers (the hospital edits them). */
  async seed(c: Queryable) {
    for (const [i, t] of TEMPLATE.entries()) {
      await c.query(`INSERT INTO membership_plans (id, code, name, description, price, period, benefits, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), t.code, t.name, t.description, t.price, t.period, JSON.stringify(t.benefits), i]);
    }
  }

  async plans(onlyActive: boolean) {
    const { rows } = await this.db.query(`SELECT * FROM membership_plans ${onlyActive ? 'WHERE active' : ''} ORDER BY sort, price`);
    return rows.map(toPlan);
  }

  /** The plan's limit on tiers (memberships.tiers): counted over active tiers. */
  private async assertTierLimit(c: Queryable, excludingId: string | null) {
    const caps = await this.entitlements.tenantFeatures(TenantContext.require().id);
    const limit = caps.features['memberships.tiers']?.limit ?? null;
    if (limit == null) return;
    const { rows: [r] } = await c.query(`SELECT count(*)::int n FROM membership_plans WHERE active AND ($1::uuid IS NULL OR id <> $1)`, [excludingId]);
    if (r.n >= limit) throw new DomainError(422, 'LIMIT_REACHED', `your plan allows ${limit} active membership tier${limit === 1 ? '' : 's'}: deactivate one first`, { limit });
  }

  async createPlan(v: PlanInput) {
    return this.db.tx(async (c) => {
      if (v.active) await this.assertTierLimit(c, null);
      const { rows: [dup] } = await c.query('SELECT 1 FROM membership_plans WHERE code = $1', [v.code]);
      if (dup) throw conflict('CODE_TAKEN', `a tier with code ${v.code} exists`);
      const { rows: [r] } = await c.query(`INSERT INTO membership_plans (id, code, name, description, price, period, benefits, active, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [randomUUID(), v.code, v.name, v.description, v.price, v.period, JSON.stringify(v.benefits), v.active, v.sort]);
      return toPlan(r);
    });
  }

  /** Edits apply to new purchases; members keep what they bought until it ends. */
  async updatePlan(id: string, v: Partial<Omit<PlanInput, 'code'>> & { version: number }) {
    return this.db.tx(async (c) => {
      const { rows: [p] } = await c.query('SELECT * FROM membership_plans WHERE id = $1 FOR UPDATE', [id]);
      if (!p) throw notFound('membership tier');
      if (p.version !== v.version) throw conflict('VERSION_CONFLICT', 'this tier changed in another window; reload');
      if (v.active === true && !p.active) await this.assertTierLimit(c, id);
      const { rows: [r] } = await c.query(
        `UPDATE membership_plans SET name = coalesce($2, name), description = coalesce($3, description), price = coalesce($4, price), period = coalesce($5, period),
           benefits = coalesce($6, benefits), active = coalesce($7, active), sort = coalesce($8, sort), version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, v.name ?? null, v.description ?? null, v.price ?? null, v.period ?? null, v.benefits ? JSON.stringify(v.benefits) : null, v.active ?? null, v.sort ?? null]);
      return toPlan(r);
    });
  }

  private async current(c: Queryable, personId: string) {
    const { rows: [m] } = await c.query(`SELECT * FROM memberships WHERE account_person_id = $1 AND status = 'ACTIVE' AND ends_at > now() ORDER BY ends_at DESC LIMIT 1`, [personId]);
    return m ?? null;
  }

  /** The patient's view: their membership (if any) and the tiers they can join. */
  async mine(actor: Actor) {
    const pool = await this.db.current();
    const m = await this.current(pool, actor.id);
    const { rows: [pending] } = await pool.query(`SELECT * FROM memberships WHERE account_person_id = $1 AND status = 'PENDING' AND created_at > now() - make_interval(mins => $2) ORDER BY created_at DESC LIMIT 1`, [actor.id, PAY_WITHIN_MIN]);
    return { membership: m ? toMembership(m) : null, pending: pending ? toMembership(pending) : null, plans: await this.plans(true) };
  }

  /**
   * Join (or renew): a PENDING membership and an online invoice in the account holder's name; it becomes active when
   * the invoice is paid. Renewing the same tier extends it; another tier can be joined once the current one ends.
   */
  async buy(actor: Actor, planId: string) {
    if (actor.kind !== 'patient') throw new DomainError(403, 'PATIENTS_ONLY', 'memberships are bought by patients');
    const t = TenantContext.require();
    const pool = await this.db.current();
    const { rows: [p] } = await pool.query('SELECT * FROM membership_plans WHERE id = $1 AND active', [planId]);
    if (!p) throw notFound('membership tier');
    const now = await this.current(pool, actor.id);
    if (now && now.plan_id !== p.id) throw conflict('ALREADY_MEMBER', `you are a ${now.plan_snapshot.name} member until ${new Date(now.ends_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}: you can change tier after that`);
    // the invoice is in the account holder's own name (their record: profile first)
    const me = await fetch(`${process.env.SVC_URL_PATIENT ?? 'http://localhost:4406'}/v1/me/patients`, { headers: { authorization: `Bearer ${actor.token}`, 'x-tenant-host': t.hosts[0] }, signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []) as { id: string; fullName: string; mrn: string; isSelf: boolean }[];
    const self = me.find((x) => x.isSelf);
    if (!self) throw new DomainError(409, 'PROFILE_REQUIRED', 'complete your profile first');
    const id = randomUUID();
    const snapshot = { code: p.code, name: p.name, price: Number(p.price), period: p.period, benefits: p.benefits };
    // an older unpaid attempt is dropped
    await pool.query(`UPDATE memberships SET status = 'CANCELLED' WHERE account_person_id = $1 AND status = 'PENDING'`, [actor.id]);
    await pool.query(`INSERT INTO memberships (id, account_person_id, patient_id, patient_name, plan_id, plan_snapshot, status) VALUES ($1,$2,$3,$4,$5,$6,'PENDING')`,
      [id, actor.id, self.id, self.fullName, p.id, JSON.stringify(snapshot)]);
    const checkout = await this.billing.openOnline({
      sourceType: 'MEMBERSHIP', sourceId: id, patientId: self.id, patientName: self.fullName, patientMrn: self.mrn, accountPersonId: actor.id,
      branchId: null, branchName: null, amount: Number(p.price), expiresAt: new Date(Date.now() + PAY_WITHIN_MIN * 60_000).toISOString(),
      description: `${p.name} membership, ${p.period === 'YEARLY' ? '1 year' : '1 month'}${now ? ' (renewal)' : ''}`,
    });
    await pool.query('UPDATE memberships SET invoice_id = $2 WHERE id = $1', [id, checkout.invoiceId]);
    return { membershipId: id, invoiceId: checkout.invoiceId };
  }

  /** The invoice is paid: active from now (or from the end of the same tier, when renewing). */
  async onPaid(c: Queryable, e: PaymentSucceeded) {
    if (e.sourceType !== 'MEMBERSHIP') return;
    const { rows: [m] } = await c.query('SELECT * FROM memberships WHERE id = $1 FOR UPDATE', [e.sourceId]);
    if (!m || m.status === 'ACTIVE') return;
    const now = await this.current(c, m.account_person_id);
    const from = now && now.plan_id === m.plan_id ? new Date(now.ends_at) : new Date();
    const to = new Date(from);
    if (m.plan_snapshot.period === 'YEARLY') to.setFullYear(to.getFullYear() + 1); else to.setMonth(to.getMonth() + 1);
    if (now && now.plan_id === m.plan_id) await c.query(`UPDATE memberships SET status = 'EXPIRED' WHERE id = $1`, [now.id]); // the renewal carries on from it
    const { rows: [r] } = await c.query(`UPDATE memberships SET status = 'ACTIVE', starts_at = $2, ends_at = $3 WHERE id = $1 RETURNING *`, [m.id, now && now.plan_id === m.plan_id ? now.starts_at : from, to]);
    await this.announce(c, r, 'ACTIVE');
    this.log.log(`membership ${m.plan_snapshot.code} active until ${to.toISOString().slice(0, 10)}`);
  }

  private async announce(c: Queryable, r: any, status: MembershipChanged['status']) {
    const data: MembershipChanged = { membershipId: r.id, accountPersonId: r.account_person_id, patientName: r.patient_name, planCode: r.plan_snapshot.code, planName: r.plan_snapshot.name, status, endsAt: new Date(r.ends_at).toISOString(), benefits: r.plan_snapshot.benefits };
    await addToOutbox(c, Topics.billing, r.account_person_id, envelope(EventTypes.membershipChanged, data, { tenantId: TenantContext.require().id, subject: r.id }));
  }

  /** Job: memberships past their end date expire (and say so); unpaid attempts are dropped. */
  async expire() {
    return this.db.tx(async (c) => {
      const { rows } = await c.query(`UPDATE memberships SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND ends_at <= now() RETURNING *`);
      for (const r of rows) await this.announce(c, r, 'EXPIRED');
      await c.query(`UPDATE memberships SET status = 'CANCELLED' WHERE status = 'PENDING' AND created_at < now() - make_interval(mins => $1)`, [PAY_WITHIN_MIN * 2]);
      return rows.length;
    });
  }

  /** For scheduling and diagnostics (internal): an account's benefits now, or none. */
  async benefitsFor(personId: string) {
    const m = await this.current(await this.db.current(), personId);
    return m ? { member: true, planCode: m.plan_snapshot.code, planName: m.plan_snapshot.name, endsAt: m.ends_at, benefits: m.plan_snapshot.benefits as MembershipBenefits } : { member: false };
  }

  /** Admin: who holds a membership now. */
  async members() {
    const { rows } = await this.db.query(`SELECT * FROM memberships WHERE status = 'ACTIVE' AND ends_at > now() ORDER BY ends_at LIMIT 500`);
    return rows.map(toMembership);
  }
}
