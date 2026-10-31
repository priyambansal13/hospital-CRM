import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { EventEnvelope } from '@mc/contracts';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { conflict, DomainError, FieldCrypto, notFound } from '@mc/nest-common';
import { type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { Inject } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import type { PlacementSource } from '@mc/tenancy';
import { randomBytes, randomUUID } from 'node:crypto';
import { publicName, WEBHOOK_EVENTS } from './catalog.js';
import { checkUrl, post } from './outbound.js';

/** retry schedule after a failed attempt (then FAILED): 30 s, 2 min, 10 min, 1 h, 6 h */
const BACKOFF_S = [30, 120, 600, 3600, 21600];
const toEndpoint = (r: any) => ({ id: r.id, kind: r.kind, name: r.name, url: r.url, events: r.events as string[], secretHint: r.secret_hint, active: r.active, version: r.version, createdAt: r.created_at });
const toDelivery = (r: any) => ({ id: r.id, endpointId: r.endpoint_id, eventId: r.event_id, eventType: r.event_type, status: r.status, attempts: r.attempts, nextAttemptAt: r.next_attempt_at, lastStatus: r.last_status, lastError: r.last_error, deliveredAt: r.delivered_at, createdAt: r.created_at });
const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/**
 * Webhooks (Phase 27): a hospital points MediCare at its own systems. Subscribed events become deliveries in the
 * same transaction as the event (so none is lost), sent by a job every few seconds with retries and backoff; the
 * signing secret is shown once and stored encrypted. The LIS connector uses the same machinery (kind LIS).
 */
@Injectable()
export class WebhooksService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Webhooks');
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly db: TenantDbRouter, private readonly crypto: FieldCrypto, private readonly entitlements: EntitlementsClient, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  private tid() { return TenantContext.require().id; }

  async list(kind: 'WEBHOOK' | 'LIS' = 'WEBHOOK') {
    const { rows } = await this.db.query('SELECT * FROM endpoints WHERE kind = $1 ORDER BY created_at', [kind]);
    return rows.map(toEndpoint);
  }

  private async limit(c: Queryable, excludingId: string | null) {
    const f = (await this.entitlements.tenantFeatures(this.tid())).features['integrations.webhooks'];
    if (f?.limit == null) return;
    const { rows: [r] } = await c.query(`SELECT count(*)::int n FROM endpoints WHERE kind = 'WEBHOOK' AND active AND ($1::uuid IS NULL OR id <> $1)`, [excludingId]);
    if (r.n >= f.limit) throw new DomainError(422, 'LIMIT_REACHED', `your plan allows ${f.limit} active webhook endpoint${f.limit === 1 ? '' : 's'}`, { limit: f.limit });
  }

  private async assertUrl(url: string) {
    const why = await checkUrl(url);
    if (why) throw new DomainError(422, 'URL_REFUSED', why);
  }

  /** New endpoint: the signing secret is in this response only. */
  async create(v: { kind?: 'WEBHOOK' | 'LIS'; name: string; url: string; events?: string[] }) {
    const kind = v.kind ?? 'WEBHOOK';
    await this.assertUrl(v.url);
    const secret = newSecret();
    return this.db.tx(async (c) => {
      if (kind === 'WEBHOOK') await this.limit(c, null);
      else {
        const { rows: [x] } = await c.query(`SELECT 1 FROM endpoints WHERE kind = 'LIS'`);
        if (x) throw conflict('LIS_EXISTS', 'the hospital already has a LIS connection: edit it instead');
      }
      const id = randomUUID();
      const { rows: [r] } = await c.query('INSERT INTO endpoints (id, kind, name, url, events, secret_enc, secret_hint) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [id, kind, v.name, v.url, JSON.stringify(kind === 'LIS' ? [] : v.events ?? []), await this.crypto.encrypt(this.tid(), `endpoint:${id}`, secret), `${secret.slice(0, 10)}…${secret.slice(-4)}`]);
      return { ...toEndpoint(r), secret };
    });
  }

  async update(id: string, v: { name?: string; url?: string; events?: string[]; active?: boolean; rotateSecret?: boolean; version: number }) {
    if (v.url) await this.assertUrl(v.url);
    const secret = v.rotateSecret ? newSecret() : null;
    return this.db.tx(async (c) => {
      const { rows: [e] } = await c.query('SELECT * FROM endpoints WHERE id = $1 FOR UPDATE', [id]);
      if (!e) throw notFound('endpoint');
      if (e.version !== v.version) throw conflict('VERSION_CONFLICT', 'this endpoint changed in another window; reload');
      if (v.active === true && !e.active && e.kind === 'WEBHOOK') await this.limit(c, id);
      const { rows: [r] } = await c.query(
        `UPDATE endpoints SET name = coalesce($2, name), url = coalesce($3, url), events = coalesce($4, events), active = coalesce($5, active),
           secret_enc = coalesce($6, secret_enc), secret_hint = coalesce($7, secret_hint), version = version + 1 WHERE id = $1 RETURNING *`,
        [id, v.name ?? null, v.url ?? null, v.events && e.kind === 'WEBHOOK' ? JSON.stringify(v.events) : null, v.active ?? null,
          secret ? await this.crypto.encrypt(this.tid(), `endpoint:${id}`, secret) : null, secret ? `${secret.slice(0, 10)}…${secret.slice(-4)}` : null]);
      return { ...toEndpoint(r), ...(secret ? { secret } : {}) };
    });
  }

  async deliveries(endpointId: string | null, limit = 50) {
    const { rows } = await this.db.query('SELECT * FROM deliveries WHERE ($1::uuid IS NULL OR endpoint_id = $1) ORDER BY created_at DESC LIMIT $2', [endpointId, limit]);
    return rows.map(toDelivery);
  }

  /** Send a ping now (the admin's "Send a test"): queued like any delivery, so it shows in the log. */
  async test(id: string) {
    const { rows: [e] } = await this.db.query('SELECT * FROM endpoints WHERE id = $1', [id]);
    if (!e) throw notFound('endpoint');
    const eventId = randomUUID();
    const payload = { id: eventId, type: 'ping', created: new Date().toISOString(), hospital: TenantContext.require().slug, data: { message: 'Test from MediCare' } };
    await this.db.query(`INSERT INTO deliveries (id, endpoint_id, event_id, event_type, payload) VALUES ($1,$2,$3,'ping',$4)`, [randomUUID(), id, eventId, JSON.stringify(payload)]);
    await this.dispatchTenant(TenantContext.require());
    return (await this.deliveries(id, 1))[0];
  }

  /** Try a failed delivery again (from now, with a fresh attempt budget). */
  async retry(deliveryId: string) {
    const { rows: [d] } = await this.db.query(`UPDATE deliveries SET status = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 AND status = 'FAILED' RETURNING *`, [deliveryId]);
    if (!d) throw conflict('NOT_FAILED', 'only a failed delivery can be retried');
    return toDelivery(d);
  }

  // ---------- events → deliveries ----------

  async onEvent(c: Queryable, e: EventEnvelope) {
    const name = publicName(e.type);
    if (!name) return;
    const { rows: eps } = await c.query(`SELECT id FROM endpoints WHERE kind = 'WEBHOOK' AND active AND events ? $1`, [name]);
    if (!eps.length || (await this.entitlements.moduleState(this.tid(), 'integrations')) !== 'ACTIVE') return;
    const payload = { id: e.id, type: name, created: e.time, hospital: TenantContext.require().slug, data: WEBHOOK_EVENTS[name].map(e.data as Record<string, unknown>) };
    for (const ep of eps) {
      await c.query('INSERT INTO deliveries (id, endpoint_id, event_id, event_type, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (endpoint_id, event_id) DO NOTHING', [randomUUID(), ep.id, e.id, name, JSON.stringify(payload)]);
    }
  }

  /** The LIS connector queues an order for the instruments the same way (kind LIS). */
  async enqueueLis(c: Queryable, eventId: string, type: string, payload: unknown) {
    const { rows: [ep] } = await c.query(`SELECT id FROM endpoints WHERE kind = 'LIS' AND active`);
    if (!ep) return false;
    await c.query('INSERT INTO deliveries (id, endpoint_id, event_id, event_type, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (endpoint_id, event_id) DO NOTHING', [randomUUID(), ep.id, eventId, type, JSON.stringify(payload)]);
    return true;
  }

  // ---------- sending ----------

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => void this.dispatchAll(), Number(process.env.WEBHOOK_DISPATCH_MS ?? 3000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  private async dispatchAll() {
    if (this.running) return;
    this.running = true;
    try {
      for (const t of await this.placements.list()) {
        if (t.status !== 'ACTIVE') continue;
        await TenantContext.run(t, () => this.dispatchTenant(t)).catch((e) => this.log.warn(`${t.slug}: ${(e as Error).message}`));
      }
    } catch (e) {
      // tenant-service unreachable (e.g. while the stack starts): try again on the next tick, never crash the service
      this.log.warn(`dispatch skipped: ${(e as Error).message}`);
    } finally { this.running = false; }
  }

  /** Due deliveries of one hospital, a batch at a time; each row is locked while it is sent. */
  async dispatchTenant(t: { id: string; slug: string }) {
    for (let batch = 0; batch < 5; batch++) {
      const sent = await this.db.tx(async (c) => {
        const { rows } = await c.query(
          `SELECT d.*, e.url, e.secret_enc, e.kind FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
           WHERE d.status = 'PENDING' AND d.next_attempt_at <= now() ORDER BY d.next_attempt_at LIMIT 10 FOR UPDATE OF d SKIP LOCKED`);
        for (const d of rows) {
          const secret = (await this.crypto.decrypt(t.id, `endpoint:${d.endpoint_id}`, d.secret_enc)) ?? '';
          const body = JSON.stringify(d.payload);
          const r = await post(d.url, secret, body, { 'x-medicare-event': d.event_type, 'x-medicare-delivery': d.id, 'x-medicare-hospital': t.slug });
          const attempts = d.attempts + 1;
          if (r.status >= 200 && r.status < 300) {
            await c.query(`UPDATE deliveries SET status = 'DELIVERED', attempts = $2, last_status = $3, last_error = NULL, delivered_at = now() WHERE id = $1`, [d.id, attempts, r.status]);
          } else {
            const done = attempts > BACKOFF_S.length;
            await c.query(`UPDATE deliveries SET status = $2, attempts = $3, last_status = $4, last_error = $5, next_attempt_at = now() + make_interval(secs => $6) WHERE id = $1`,
              [d.id, done ? 'FAILED' : 'PENDING', attempts, r.status || null, r.error, BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)]]);
          }
        }
        return rows.length;
      });
      if (sent < 10) return;
    }
  }
}
