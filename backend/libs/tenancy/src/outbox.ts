import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@mc/contracts';
import type { Queryable } from './db.js';

/** Build an event envelope (ids are random UUIDs; ordering comes from the outbox id and Kafka partition key). */
export function envelope<T extends Record<string, unknown>>(type: string, data: T, opts: { tenantId?: string; subject?: string; source?: string } = {}): EventEnvelope<T> {
  return {
    specversion: '1.0',
    id: randomUUID(),
    type,
    source: opts.source ?? process.env.SERVICE_NAME ?? 'unknown',
    time: new Date().toISOString(),
    tenantId: opts.tenantId,
    subject: opts.subject,
    data,
  };
}

/** Write an event to the outbox in the SAME transaction as the state change it describes. */
export async function addToOutbox(client: Queryable, topic: string, key: string, event: EventEnvelope) {
  await client.query('INSERT INTO outbox (topic, key, event) VALUES ($1, $2, $3)', [topic, key, JSON.stringify(event)]);
}
