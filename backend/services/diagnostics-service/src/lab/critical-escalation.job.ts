import { Body, Controller, HttpCode, Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown, Param, Post } from '@nestjs/common';
import { Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { z } from 'zod';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { ResultsService } from './results.service.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;

/** Critical values nobody has acknowledged move up the escalation ladder (review C-2); every minute, per hospital. */
@Injectable()
export class CriticalEscalationJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('CriticalEscalation');
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: TenantDbRouter, private readonly results: ResultsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly entitlements: EntitlementsClient) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => this.runOnce().catch((e) => this.log.warn((e as Error).message)), Number(process.env.CRITICAL_ESCALATION_INTERVAL_MS ?? 60_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async runOnce() {
    const n = Number(process.env.REPLICA_COUNT ?? 1);
    const i = Number(process.env.REPLICA_INDEX ?? 0);
    let total = 0;
    for (const t of await this.placements.list()) {
      if (t.status !== 'ACTIVE' || shardOf(t.id, n) !== i) continue;
      // only where diagnostics is in full use: a read-only lab takes no new results
      if ((await this.entitlements.moduleState(t.id, 'diagnostics').catch(() => 'OFF')) !== 'ACTIVE') continue;
      total += await TenantContext.run(t, () => this.db.tx((c) => this.results.escalateDue(c))).catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
    }
    if (total) this.log.warn(`${total} critical value(s) escalated`);
    return total;
  }
}

/** Ops/tests: run the escalation for one hospital now (`dueNow`: treat every open alert as due). */
@Controller('internal/tenants/:tenantId/lab')
export class InternalLabJobsController {
  constructor(private readonly db: TenantDbRouter, private readonly results: ResultsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post('critical-escalation')
  @Internal()
  @HttpCode(200)
  async sweep(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    const { dueNow } = parse(z.object({ dueNow: z.boolean().default(false) }), body ?? {});
    return TenantContext.run(await this.placements.get(tenantId), () => this.db.tx(async (c) => {
      if (dueNow) await c.query('UPDATE critical_alerts SET escalate_at = now() WHERE acknowledged_at IS NULL AND communicated_at IS NULL AND level < 2');
      return { escalated: await this.results.escalateDue(c) };
    }));
  }
}
