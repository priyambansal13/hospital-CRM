import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventTypes, type StaffNotice, Topics } from '@mc/contracts';
import { addToOutbox, envelope, withTx } from '@mc/tenancy';
import { CONTROL_DB, DomainError, isDev, REDIS, type Redis, smtpOptions } from '@mc/nest-common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type pg from 'pg';
import { CatalogRepo } from '../catalog/catalog.repo.js';
import { ProvisioningService } from '../catalog/provisioning.service.js';

/** Subdomains a hospital can never take (MediCare's own, or confusing). */
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'medicare', 'console', 'platform', 'account', 'care', 'help', 'support', 'status', 'mail', 'static', 'cdn', 'login', 'auth', 'signup', 'pricing', 'docs', 'blog', 'billing', 'security', 'internal']);
const SLUG = /^[a-z][a-z0-9-]{2,30}$/;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const site = () => process.env.PUBLIC_SITE_URL ?? 'http://medicare.localhost:3400';

export interface SignupInput { hospitalName: string; slug: string; adminName: string; adminEmail: string; phone: string | null; plan: string }
type Check = { key: string; label: string; done: boolean };
type Signup = { id: string; slug: string; hospital_name: string; admin_name: string; admin_email: string; plan_code: string; status: string; tenant_id: string | null; verified_at: string | null };
const STUCK_MS = 10 * 60_000;
const urls = (slug: string) => {
  const port = new URL(site()).port;
  const base = `${new URL(site()).protocol}//${slug}.${process.env.TENANT_BASE_DOMAIN ?? 'localhost'}${port ? `:${port}` : ''}`;
  return { base, login: `${base}/login?next=${encodeURIComponent('/admin/setup')}` };
};

/**
 * Self-serve signup (docs/MULTI-TENANCY.md §6, PRODUCT-MODULES-AND-PLANS.md §10): the owner confirms their e-mail,
 * then the provisioning saga runs (database, Keycloak organisation and owner login, roles, plan and trial, defaults,
 * storage bucket, data key) and the status page follows each step until the hospital is ready.
 */
@Injectable()
export class SignupService {
  private readonly log = new Logger('Signup');
  private readonly mail = nodemailer.createTransport(smtpOptions());

  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool, @Inject(REDIS) private readonly redis: Redis, private readonly catalog: CatalogRepo, private readonly provisioning: ProvisioningService) {}

  async available(slug: string): Promise<{ slug: string; available: boolean; reason: string | null }> {
    const s = slug.toLowerCase();
    if (!SLUG.test(s)) return { slug: s, available: false, reason: 'use 3–31 lowercase letters, digits or dashes, starting with a letter' };
    if (RESERVED.has(s)) return { slug: s, available: false, reason: 'this name is reserved' };
    if (await this.catalog.findBySlug(s)) return { slug: s, available: false, reason: 'already taken' };
    const { rows } = await this.db.query(`SELECT 1 FROM signups WHERE slug = $1 AND status IN ('PENDING','PROVISIONING','READY') AND (status <> 'PENDING' OR expires_at > now())`, [s]);
    if (rows[0]) return { slug: s, available: false, reason: 'already taken' };
    return { slug: s, available: true, reason: null };
  }

  /** A few signups per address and network per hour (no captcha yet). */
  private async rateLimit(key: string, max: number) {
    const n = await this.redis.incr(`signup:rl:${key}`);
    if (n === 1) await this.redis.expire(`signup:rl:${key}`, 3600);
    if (n > max) throw new DomainError(429, 'TOO_MANY_SIGNUPS', 'too many signups from here: try again in an hour');
  }

  private async plans(): Promise<{ code: string; name: string; trialDays: number }[]> {
    const res = await fetch(`${process.env.SVC_URL_SUBSCRIPTION ?? 'http://localhost:4413'}/internal/plans`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' } });
    if (!res.ok) throw new DomainError(503, 'PLANS_UNAVAILABLE', 'plans are unavailable, please try again');
    return ((await res.json()) as { plans: { code: string; name: string; trialDays: number }[] }).plans;
  }

  async start(input: SignupInput, ip: string | null) {
    await this.rateLimit(`email:${input.adminEmail.toLowerCase()}`, 3);
    // per network: 10 an hour (dev: 200, so repeated local test runs are not blocked)
    if (ip) await this.rateLimit(`ip:${ip}`, Number(process.env.SIGNUP_IP_LIMIT ?? (isDev() ? 200 : 10)));
    const slug = await this.available(input.slug);
    if (!slug.available) throw new DomainError(409, 'SLUG_TAKEN', `${input.slug}: ${slug.reason}`, { field: 'slug' });
    const plan = (await this.plans()).find((p) => p.code === input.plan);
    if (!plan) throw new DomainError(422, 'UNKNOWN_PLAN', `no plan ${input.plan}`);
    const token = randomBytes(24).toString('base64url');
    const id = randomUUID();
    // an unconfirmed signup that expired gives its subdomain back
    await this.db.query(`UPDATE signups SET status = 'EXPIRED' WHERE slug = $1 AND status = 'PENDING' AND expires_at <= now()`, [slug.slug]);
    await this.db.query(`INSERT INTO signups (id, token_hash, slug, hospital_name, admin_name, admin_email, phone, plan_code, status, ip, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9, now() + interval '24 hours')`,
      [id, hash(token), slug.slug, input.hospitalName, input.adminName, input.adminEmail.toLowerCase(), input.phone, plan.code, ip]);
    const link = `${site()}/signup/verify?token=${token}`;
    await this.mail.sendMail({
      from: 'MediCare <hello@medicare.example>', to: input.adminEmail, subject: `Confirm ${input.hospitalName} on MediCare`,
      text: `Hello ${input.adminName},\n\nConfirm your e-mail to create ${input.hospitalName} on MediCare (${plan.name}, ${plan.trialDays}-day free trial):\n\n${link}\n\nThe link works for 24 hours. If you did not sign up, ignore this e-mail.\n\nMediCare`,
    });
    this.log.log(`signup ${slug.slug} (${plan.code}) waiting for e-mail confirmation`);
    return { id, status: 'PENDING', email: input.adminEmail.toLowerCase() };
  }

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new DomainError(404, 'NOT_FOUND', 'this link is not valid');
    const { rows: [s] } = await this.db.query('SELECT * FROM signups WHERE token_hash = $1', [hash(token)]);
    if (!s) throw new DomainError(404, 'NOT_FOUND', 'this link is not valid');
    return s;
  }

  /** The e-mail link: start provisioning (once). Returns at once; the status page follows the steps. */
  async verify(token: string) {
    const s = await this.byToken(token);
    if (s.status === 'PENDING') {
      if (new Date(s.expires_at) < new Date()) {
        await this.db.query(`UPDATE signups SET status = 'EXPIRED' WHERE id = $1`, [s.id]);
        throw new DomainError(410, 'SIGNUP_EXPIRED', 'this link has expired: please sign up again');
      }
      const { rowCount } = await this.db.query(`UPDATE signups SET status = 'PROVISIONING', verified_at = now() WHERE id = $1 AND status = 'PENDING'`, [s.id]);
      if (rowCount) void this.provision(s);
    }
    return this.status(token);
  }

  private async provision(s: { id: string; slug: string; hospital_name: string; admin_name: string; admin_email: string; plan_code: string }) {
    try {
      const t = await this.provisioning.create({ slug: s.slug, name: s.hospital_name, adminEmail: s.admin_email, adminName: s.admin_name, plan: s.plan_code, source: 'SIGNUP' });
      await this.db.query('UPDATE signups SET tenant_id = $2 WHERE id = $1', [s.id, t.id]);
      this.log.log(`signup ${s.slug}: hospital database ready; services are setting up the rest`);
    } catch (e) {
      await this.fail(s, (e as Error).message);
    }
  }

  private async svc<T>(name: string, path: string): Promise<T | null> {
    const res = await fetch(`${process.env[`SVC_URL_${name}`] ?? ''}${path}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(4000) }).catch(() => null);
    return res?.ok ? ((await res.json()) as T) : null;
  }

  /** Each provisioning step as the services see it (all done = the hospital is ready to use). */
  async readiness(tenantId: string, adminEmail: string): Promise<Check[]> {
    const t = await this.catalog.find(tenantId);
    const [staff, owners, modules, billing, storage] = await Promise.all([
      this.svc<{ userId: string; active: boolean }>('IAM', `/internal/tenants/${tenantId}/staff?email=${encodeURIComponent(adminEmail)}`),
      this.svc<{ userIds: string[] }>('ENTITLEMENT', `/internal/tenants/${tenantId}/users-with-permission/settings:manage:tenant`),
      this.svc<{ state: string }[]>('ENTITLEMENT', `/internal/tenants/${tenantId}/module-states`),
      this.svc<{ status: string }>('SUBSCRIPTION', `/internal/tenants/${tenantId}/billing`),
      this.svc<{ bucket: boolean; key: boolean }>('RECORDS', `/internal/tenants/${tenantId}/storage`),
    ]);
    return [
      { key: 'database', label: 'Your hospital\'s own database', done: t?.status === 'ACTIVE' },
      // the login exists AND its hospital admin role is assigned (entitlement-service, from iam.staff_joined)
      { key: 'login', label: 'Your login (owner)', done: !!staff && !!owners?.userIds.includes(staff.userId) },
      { key: 'modules', label: 'Modules of your plan switched on', done: !!modules?.length && modules.every((m) => m.state === 'ACTIVE') },
      { key: 'trial', label: 'Free trial started', done: billing?.status === 'TRIALING' },
      { key: 'storage', label: 'Secure file storage and encryption key', done: !!storage?.bucket && !!storage.key },
    ];
  }

  /**
   * Moves a provisioning signup on: READY when every step is done (the owner gets an e-mail), FAILED when it is not
   * done after 10 minutes (MediCare support gets a notice). Run by the status page and by the sweep, so it happens
   * even when nobody has the page open; the conditional UPDATE makes each move (and its message) happen once.
   */
  async settle(s: Signup): Promise<{ status: string; steps: Check[] }> {
    if (s.status !== 'PROVISIONING' && s.status !== 'READY') return { status: s.status, steps: [] };
    const age = Date.now() - new Date(s.verified_at ?? Date.now()).getTime();
    if (!s.tenant_id) {
      // the saga stopped before the hospital existed (the service restarted mid-way)
      if (s.status === 'PROVISIONING' && age > STUCK_MS) return { status: (await this.fail(s, 'provisioning stopped before the hospital was created')) ? 'FAILED' : s.status, steps: [] };
      return { status: s.status, steps: [] };
    }
    const steps = await this.readiness(s.tenant_id, s.admin_email);
    if (s.status !== 'PROVISIONING') return { status: s.status, steps };
    const missing = steps.filter((x) => !x.done).map((x) => x.key);
    if (!missing.length) {
      const { rowCount } = await this.db.query(`UPDATE signups SET status = 'READY', ready_at = now() WHERE id = $1 AND status = 'PROVISIONING'`, [s.id]);
      if (!rowCount) return { status: 'READY', steps };
      this.log.log(`signup ${s.slug} ready in ${Math.round(age / 1000)} s`);
      const { base, login } = urls(s.slug);
      await this.mail.sendMail({
        from: 'MediCare <hello@medicare.example>', to: s.admin_email, subject: `${s.hospital_name} is ready on MediCare`,
        text: `Hello ${s.admin_name},\n\n${s.hospital_name} is set up and your free trial has started. Sign in to finish the setup (branches, doctors, timings):\n\n${login}\n\nYour hospital's address: ${base}\n\nMediCare`,
      }).catch((e) => this.log.warn(`signup ${s.slug}: ready e-mail not sent: ${(e as Error).message}`));
      return { status: 'READY', steps };
    }
    // something did not finish (a service is down or an event went to its DLQ)
    if (age > STUCK_MS && (await this.fail(s, `not ready after 10 minutes: ${missing.join(', ')}`))) return { status: 'FAILED', steps };
    return { status: 'PROVISIONING', steps };
  }

  /** Marks the signup FAILED and tells MediCare support (in the same transaction). False if it had already moved on. */
  private async fail(s: Pick<Signup, 'id' | 'slug' | 'hospital_name' | 'admin_name' | 'admin_email'> & { tenant_id?: string | null }, reason: string) {
    this.log.error(`signup ${s.slug} failed: ${reason}`);
    const hq = await this.catalog.findBySlug(process.env.HQ_SLUG ?? 'medicare');
    return withTx(this.db, async (c) => {
      const { rowCount } = await c.query(`UPDATE signups SET status = 'FAILED', error = $2 WHERE id = $1 AND status = 'PROVISIONING'`, [s.id, reason.slice(0, 500)]);
      if (!rowCount) return false;
      if (hq) {
        const n: StaffNotice = {
          permission: 'customer:manage:tenant', subject: `Signup failed: ${s.hospital_name} (${s.slug})`,
          message: `The self-serve signup of ${s.hospital_name} by ${s.admin_name} <${s.admin_email}> did not finish: ${reason}. Their status page says our team has been told: contact them, fix the cause, and finish or remove the hospital.`,
          linkPath: s.tenant_id ? `/platform/hospitals/${s.tenant_id}` : '/platform/hospitals', dedupe: `signup-failed:${s.id}`,
        };
        await addToOutbox(c, Topics.tenant, hq.id, envelope(EventTypes.staffNotice, n, { tenantId: hq.id }));
      } else this.log.warn('no MediCare HQ account: nobody to tell about the failed signup');
      return true;
    });
  }

  /** Signups still provisioning (the sweep settles them). */
  async inProgress(): Promise<Signup[]> {
    return (await this.db.query(`SELECT * FROM signups WHERE status = 'PROVISIONING' ORDER BY verified_at LIMIT 100`)).rows;
  }

  async status(token: string) {
    const s = await this.byToken(token);
    const { status, steps } = await this.settle(s);
    const { base, login } = urls(s.slug);
    return {
      id: s.id, status, slug: s.slug, hospitalName: s.hospital_name, email: s.admin_email, plan: s.plan_code, error: status === 'FAILED' ? 'We could not finish setting up. Our team has been told.' : null,
      steps, url: base, loginUrl: status === 'READY' ? login : null,
    };
  }
}
