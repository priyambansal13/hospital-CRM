import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { NO_SHOW_GRACE_MINUTES, QueueService } from './queue.service.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;

/**
 * Marks confirmed appointments that never checked in as NO_SHOW once they are NO_SHOW_GRACE_MINUTES past their end.
 * Every 5 minutes, per hospital database, sharded across replicas like the horizon job. Idempotent.
 */
@Injectable()
export class NoShowJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('NoShowJob');
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: TenantDbRouter, private readonly queue: QueueService, @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly entitlements: EntitlementsClient) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    const run = () => this.runOnce().catch((e) => this.log.warn(`no-show sweep failed: ${(e as Error).message}`));
    setTimeout(run, 5_000);
    this.timer = setInterval(run, Number(process.env.NO_SHOW_INTERVAL_MS ?? 300_000));
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    const n = Number(process.env.REPLICA_COUNT ?? 1);
    const i = Number(process.env.REPLICA_INDEX ?? 0);
    let total = 0;
    for (const t of await this.placements.list()) {
      if (t.status !== 'ACTIVE' || shardOf(t.id, n) !== i) continue;
      // the queue sweep only runs where the front desk module is in use
      if ((await this.entitlements.moduleState(t.id, 'front_desk').catch(() => 'OFF')) !== 'ACTIVE') continue;
      total += await TenantContext.run(t, () => this.db.tx((c) => this.queue.markNoShows(c, NO_SHOW_GRACE_MINUTES)))
        .catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
    }
    if (total) this.log.log(`marked ${total} no-show(s)`);
    return total;
  }
}
