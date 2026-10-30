import { Logger } from '@nestjs/common';
import { dlqMessages } from '../metrics.js';
import { EventEnvelope } from '@mc/contracts';
import { createConsumer, createProducer, type KafkaMessageIn, type Producer } from '@mc/kafka';
import { type PlacementSource, TenantContext, type TenantDbRouter, TenantUnavailableError, withTx } from '@mc/tenancy';
import type pg from 'pg';

export type EventHandler = (event: EventEnvelope<any>, db: pg.PoolClient | undefined) => Promise<void>;

export interface ConsumerSpec {
  /** consumer group, e.g. "iam.tenant-provisioning" */
  group: string;
  topics: string[];
  handlers: Record<string, EventHandler>;
}

/**
 * Idempotent event consumer. Tenant events run inside TenantContext and a transaction on that tenant's own
 * database; the event id is recorded in processed_events in the same transaction, so redelivery is a no-op.
 * Failures retry 3 times, then go to <topic>.dlq.
 */
export class EventConsumer {
  private readonly log = new Logger('EventConsumer');
  private dlq?: Producer;
  private consumer?: { disconnect(): Promise<void> };

  constructor(
    private readonly spec: ConsumerSpec,
    private readonly deps: { control?: pg.Pool; router?: TenantDbRouter; placements: PlacementSource },
  ) {}

  async start() {
    this.dlq = await createProducer(`${process.env.SERVICE_NAME}-dlq`);
    this.consumer = await createConsumer(`${process.env.SERVICE_NAME}`, this.spec.group, this.spec.topics, (m) => this.onMessage(m));
    this.log.log(`consumer ${this.spec.group} on ${this.spec.topics.join(', ')}`);
  }

  async stop() {
    await this.consumer?.disconnect().catch(() => undefined);
    await this.dlq?.disconnect().catch(() => undefined);
  }

  /** Process one event (exposed for tests). */
  async handle(event: EventEnvelope<any>) {
    const handler = this.spec.handlers[event.type];
    if (!handler) return;
    let pool: pg.Pool | undefined;
    try {
      pool = event.tenantId && this.deps.router ? await this.deps.router.forTenant(event.tenantId) : this.deps.control;
    } catch (e) {
      // a deleted hospital's events have nothing left to act on (e.g. a new consumer group replaying history)
      if (e instanceof TenantUnavailableError && e.status === 'DELETED') return;
      throw e;
    }
    const run = async () => {
      if (!pool) return handler(event, undefined);
      await withTx(pool, async (c) => {
        const { rowCount } = await c.query('INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [this.spec.group, event.id]);
        if (!rowCount) return;
        await handler(event, c);
      });
    };
    if (event.tenantId) return TenantContext.run(await this.deps.placements.get(event.tenantId), run, `evt-${event.id}`);
    return run();
  }

  private async onMessage(m: KafkaMessageIn) {
    let event: EventEnvelope<any>;
    try {
      event = EventEnvelope.parse(JSON.parse(m.value ?? 'null')) as EventEnvelope<any>;
    } catch (e) {
      this.log.error(`invalid event on ${m.topic}@${m.offset}: ${(e as Error).message}`);
      await this.toDlq(m, e as Error);
      return;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await this.handle(event);
        return;
      } catch (e) {
        if (attempt >= 3) {
          this.log.error(`${event.type} ${event.id} failed ${attempt}x → DLQ: ${(e as Error).message}`);
          await this.toDlq(m, e as Error);
          return;
        }
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      }
    }
  }

  private async toDlq(m: KafkaMessageIn, e: Error) {
    dlqMessages.inc({ topic: m.topic, consumer: this.spec.group });
    await this.dlq?.send(`${m.topic}.dlq`, [{ key: m.key ?? '', value: m.value ?? '', headers: { ...m.headers, 'dlq-error': e.message.slice(0, 500), 'dlq-consumer': this.spec.group } }]);
  }
}
