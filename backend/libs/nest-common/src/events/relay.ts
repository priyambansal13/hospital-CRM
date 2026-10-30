import { Logger } from '@nestjs/common';
import { createProducer, type Producer } from '@mc/kafka';
import { type PlacementSource, type TenantDbRouter, withTx } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { outboxPending, outboxPublished, retentionDeleted } from '../metrics.js';

/** Retention (review H-5): published events and dedupe records are kept this long (days), then removed. */
const OUTBOX_DAYS = () => Number(process.env.OUTBOX_RETENTION_DAYS ?? 7);
const PROCESSED_DAYS = () => Number(process.env.PROCESSED_EVENTS_RETENTION_DAYS ?? 30);

const shardOf = (id: string, count: number) => createHash('md5').update(id).digest().readUInt32BE(0) % count;

/**
 * Transactional outbox relay (docs/MULTI-TENANCY.md §3.6). Polls the service's control-plane outbox and the outbox
 * in every tenant database assigned to this replica (REPLICA_INDEX / REPLICA_COUNT), publishes to Kafka, marks rows
 * published. At-least-once: consumers dedupe on the event id.
 */
export class OutboxRelay {
  private readonly log = new Logger('OutboxRelay');
  private producer?: Producer;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private lastRetention = 0;

  constructor(
    private readonly opts: { control?: pg.Pool; router?: TenantDbRouter; placements: PlacementSource; intervalMs?: number },
  ) {}

  async start() {
    this.producer = await createProducer(`${process.env.SERVICE_NAME}-outbox`);
    const tick = async () => {
      if (this.stopped) return;
      await this.flushAll().catch((e) => this.log.warn(`relay tick failed: ${(e as Error).message}`));
      this.timer = setTimeout(tick, this.opts.intervalMs ?? 500);
    };
    void tick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.producer?.disconnect().catch(() => undefined);
  }

  /** One pass over control + this replica's tenants. Exposed for tests. */
  async flushAll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    let pending = 0;
    // once an hour, also apply the retention rules (event payloads can carry personal data; review H-5)
    const retention = Date.now() - this.lastRetention > 3_600_000;
    if (retention) this.lastRetention = Date.now();
    const pass = async (pool: pg.Pool) => {
      sent += await this.flush(pool);
      pending += Number((await pool.query('SELECT count(*) AS n FROM outbox WHERE published_at IS NULL')).rows[0].n);
      if (retention) await this.retain(pool);
    };
    try {
      if (this.opts.control) await pass(this.opts.control);
      if (this.opts.router) {
        const count = Number(process.env.REPLICA_COUNT ?? 1);
        const index = Number(process.env.REPLICA_INDEX ?? 0);
        const tenants = (await this.opts.placements.list()).filter((t) => (t.status === 'ACTIVE' || t.status === 'READ_ONLY') && shardOf(t.id, count) === index);
        for (const t of tenants) {
          try {
            await pass(await this.opts.router.forTenant(t.id));
          } catch (e) {
            this.log.warn(`outbox ${t.slug}: ${(e as Error).message}`);
          }
        }
      }
    } finally {
      this.running = false;
    }
    outboxPending.set(pending);
    if (sent) outboxPublished.inc(sent);
    return sent;
  }

  /** Published outbox rows after OUTBOX_RETENTION_DAYS, dedupe records after PROCESSED_EVENTS_RETENTION_DAYS. */
  private async retain(pool: pg.Pool) {
    const o = await pool.query('DELETE FROM outbox WHERE published_at < now() - make_interval(days => $1)', [OUTBOX_DAYS()]);
    const p = await pool.query('DELETE FROM processed_events WHERE processed_at < now() - make_interval(days => $1)', [PROCESSED_DAYS()]).catch(() => ({ rowCount: 0 }));
    if (o.rowCount) retentionDeleted.inc({ table: 'outbox' }, o.rowCount);
    if (p.rowCount) retentionDeleted.inc({ table: 'processed_events' }, p.rowCount);
  }

  private async flush(pool: pg.Pool): Promise<number> {
    return withTx(pool, async (c) => {
      const { rows } = await c.query<{ id: string; topic: string; key: string; event: any }>(
        'SELECT id, topic, key, event FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED',
      );
      if (!rows.length) return 0;
      for (const r of rows) {
        await this.producer!.send(r.topic, [{ key: r.key, value: JSON.stringify(r.event), headers: { 'event-type': r.event.type, 'event-id': r.event.id, ...(r.event.tenantId ? { 'tenant-id': r.event.tenantId } : {}) } }]);
      }
      await c.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
      return rows.length;
    });
  }
}
