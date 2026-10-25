import { EventConsumer, OutboxRelay } from '@mc/nest-common';
import { addToOutbox, envelope, HttpPlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { afterAll, describe, expect, it } from 'vitest';

process.env.SERVICE_NAME ??= 'tenant-service-test';
const placements = new HttpPlacementSource();
const router = new TenantDbRouter(placements, 'tenant');
afterAll(() => router.close());

describe('events (outbox + idempotent consumer) on a tenant database', () => {
  it('a redelivered event is handled exactly once, in the event tenant’s own database', async () => {
    const t = await placements.resolveHost('citycare.localhost');
    let calls = 0;
    let dbSeen = '';
    const consumer = new EventConsumer(
      { group: `test-${Date.now()}`, topics: [], handlers: { 'test.happened': async (_e, db) => { calls++; dbSeen = (await db!.query('SELECT current_database() d')).rows[0].d; } } },
      { router, placements },
    );
    const evt = envelope('test.happened', { x: 1 }, { tenantId: t.id });
    await consumer.handle(evt);
    await consumer.handle(evt);
    expect(calls).toBe(1);
    expect(dbSeen).toBe('t_citycare');
  });

  it('the relay publishes rows written to a tenant outbox and marks them published', async () => {
    const t = await placements.resolveHost('sunrise.localhost');
    await TenantContext.run(t, () => router.tx((c) => addToOutbox(c, 'tenant.events', t.id, envelope('test.relay', { ok: true }, { tenantId: t.id }))));
    const relay = new OutboxRelay({ router, placements });
    await relay.start();
    try {
      for (let i = 0; i < 20; i++) {
        const { rows } = await (await router.forTenant(t.id)).query("SELECT count(*)::int n FROM outbox WHERE published_at IS NULL");
        if (rows[0].n === 0) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('outbox not drained');
    } finally {
      await relay.stop();
    }
  });
});
