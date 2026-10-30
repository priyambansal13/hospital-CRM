import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SmsNotRegistered } from '@mc/nest-common';
import { PLACEMENTS } from '@mc/nest-common';
import { UsageMeter } from '@mc/entitlements-sdk';
import { type PlacementSource, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { EmailChannel, type NotificationChannel, SmsChannel } from '../channels/channels.js';
import { render } from './templates.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;
const MAX_ATTEMPTS = 5;

/**
 * Sends due messages (docs/LLD.md §14): re-checks that an appointment is still on before a reminder, resolves the
 * recipient's current contact details and preferences at send time, renders the hospital's template in the person's
 * language (falls back to English), retries with backoff, gives up after 5 attempts.
 */
@Injectable()
export class DispatcherJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Dispatcher');
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly channels: Record<string, NotificationChannel>;

  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource, email: EmailChannel, sms: SmsChannel, private readonly meter: UsageMeter) {
    this.channels = { EMAIL: email, SMS: sms };
  }

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => void this.runOnce().catch((e) => this.log.warn(`dispatch failed: ${(e as Error).message}`)), Number(process.env.NOTIFY_INTERVAL_MS ?? 5000));
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      const n = Number(process.env.REPLICA_COUNT ?? 1), i = Number(process.env.REPLICA_INDEX ?? 0);
      for (const t of await this.placements.list()) {
        if (t.status !== 'ACTIVE' || shardOf(t.id, n) !== i) continue;
        sent += await TenantContext.run(t, () => this.db.tx((c) => this.dispatchTenant(c, t.id, t.slug, t.name))).catch((e) => {
          this.log.warn(`${t.slug}: ${(e as Error).message}`);
          return 0;
        });
      }
    } finally {
      this.running = false;
    }
    return sent;
  }

  private async dispatchTenant(c: Queryable, tenantId: string, slug: string, hospital: string): Promise<number> {
    const { rows } = await c.query(`SELECT * FROM notifications WHERE status = 'SCHEDULED' AND send_at <= now() ORDER BY send_at LIMIT 50 FOR UPDATE SKIP LOCKED`);
    let sent = 0;
    for (const n of rows) {
      const skip = (why: string) => c.query(`UPDATE notifications SET status = 'SKIPPED', last_error = $2 WHERE id = $1`, [n.id, why]);
      try {
        if (n.template_key.startsWith('reminder_') && !(await this.appointmentStillOn(tenantId, n.related_id))) { await skip('appointment no longer active'); continue; }
        const contact = n.recipient_kind === 'staff' ? await this.staffContact(tenantId, n.recipient_person_id) : (await c.query('SELECT * FROM contacts WHERE person_id = $1', [n.recipient_person_id])).rows[0];
        if (n.recipient_kind === 'staff' && !contact) { await skip('staff member not found or disabled'); continue; }
        const to = n.channel === 'SMS' ? contact?.phone : contact?.email;
        if (!to) { await skip(`no ${n.channel === 'SMS' ? 'phone' : 'email'} on file`); continue; }
        if ((n.channel === 'SMS' && !contact.sms_enabled) || (n.channel === 'EMAIL' && !contact.email_enabled)) { await skip('turned off by the recipient'); continue; }
        const { rows: [tpl] } = await c.query(
          `SELECT * FROM templates WHERE key = $1 AND channel = $2 AND active AND language IN ($3, 'en') ORDER BY (language = $3) DESC LIMIT 1`,
          [n.template_key, n.channel, contact.language],
        );
        if (!tpl) { await skip('no active template'); continue; }
        const subject = tpl.subject ? render(tpl.subject, n.vars) : null;
        const body = render(tpl.body, n.vars);
        // SMS count towards the plan's monthly allowance (core.sms); with BLOCK the message is skipped once it is used up
        if (n.channel === 'SMS') {
          const q = await this.meter.reserve(tenantId, 'core.sms');
          if (!q.allowed) { await skip(`SMS allowance used up (${q.limit} this month)`); continue; }
        }
        let r: { providerMessageId: string | null };
        try {
          // SMS: the DLT-registered template and its variables (by name), for providers that need them (A-2)
          const template = n.channel === 'SMS' && tpl.provider_template_id
            ? { providerTemplateId: tpl.provider_template_id, vars: Object.fromEntries(Object.entries(n.vars ?? {}).map(([k, v]) => [k, v == null ? '' : String(v)])) }
            : null;
          r = await this.channels[n.channel].send({ to, subject: subject ?? undefined, body, fromName: hospital, tenantSlug: slug, template });
        } catch (e) {
          if (n.channel === 'SMS') await this.meter.release(tenantId, 'core.sms').catch(() => undefined);
          // not registered on DLT: retrying cannot help (the admin adds the template id)
          if (e instanceof SmsNotRegistered) { await skip('SMS template not registered (DLT): add its template id in Messages'); continue; }
          throw e;
        }
        await c.query(`UPDATE notifications SET status = 'SENT', sent_at = now(), attempts = attempts + 1, to_address = $2, rendered_subject = $3, rendered_body = $4, provider_message_id = $5, last_error = NULL WHERE id = $1`,
          [n.id, to, subject, body, r.providerMessageId]);
        sent++;
      } catch (e) {
        const attempts = n.attempts + 1;
        await c.query(
          `UPDATE notifications SET attempts = $2, last_error = $3, status = CASE WHEN $2 >= $4 THEN 'FAILED' ELSE 'SCHEDULED' END,
             send_at = now() + make_interval(mins => power(2, $2)::int) WHERE id = $1`,
          [n.id, attempts, (e as Error).message.slice(0, 500), MAX_ATTEMPTS],
        );
      }
    }
    return sent;
  }

  /** Staff: email only, looked up fresh (a disabled account gets nothing). */
  private async staffContact(tenantId: string, userId: string) {
    const res = await fetch(`${process.env.SVC_URL_IAM ?? 'http://localhost:4402'}/internal/tenants/${tenantId}/staff/${userId}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`iam-service ${res.status}`);
    const s = (await res.json()) as { email: string; active: boolean };
    return s.active ? { email: s.email, phone: null, sms_enabled: false, email_enabled: true, language: 'en' } : null;
  }

  private async appointmentStillOn(tenantId: string, appointmentId: string) {
    const res = await fetch(`${process.env.SVC_URL_SCHEDULING ?? 'http://localhost:4405'}/internal/tenants/${tenantId}/appointments/${appointmentId}/status`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' } });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`scheduling-service ${res.status}`);
    const { status } = (await res.json()) as { status: string };
    // reminders are for patients still to come: once checked in (or seen, or no-show) they are skipped
    return ['CONFIRMED', 'PENDING_PAYMENT'].includes(status);
  }
}
