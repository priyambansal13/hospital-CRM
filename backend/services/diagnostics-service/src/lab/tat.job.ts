import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { ResultsService } from './results.service.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;

/** Turnaround-time monitor: every minute (a cheap indexed query), orders past their promised report time are flagged (once). */
@Injectable()
export class TatJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('TatMonitor');
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: TenantDbRouter, private readonly results: ResultsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly entitlements: EntitlementsClient) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => this.runOnce().catch((e) => this.log.warn((e as Error).message)), Number(process.env.TAT_INTERVAL_MS ?? 60_000));
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
      total += await TenantContext.run(t, () => this.db.tx((c) => this.results.markOverdue(c))).catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
    }
    if (total) this.log.warn(`${total} lab order(s) past their turnaround time`);
    return total;
  }
}
