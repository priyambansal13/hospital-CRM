import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { LabService } from './lab.service.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;

/** Online lab bookings never paid: every 30 s, per hospital → EXPIRED (frees the place; billing voids the invoice). */
@Injectable()
export class LabHoldExpiryJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('LabHoldExpiry');
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: TenantDbRouter, private readonly lab: LabService, @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly entitlements: EntitlementsClient) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => this.runOnce().catch((e) => this.log.warn((e as Error).message)), Number(process.env.HOLD_EXPIRY_INTERVAL_MS ?? 30_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async runOnce() {
    const n = Number(process.env.REPLICA_COUNT ?? 1);
    const i = Number(process.env.REPLICA_INDEX ?? 0);
    let total = 0;
    for (const t of await this.placements.list()) {
      if (t.status !== 'ACTIVE' || shardOf(t.id, n) !== i) continue;
      // also while read-only: unpaid bookings made before the downgrade still expire (frees nothing new, voids the invoice)
      if ((await this.entitlements.moduleState(t.id, 'diagnostics').catch(() => 'OFF')) === 'OFF') continue;
      total += await TenantContext.run(t, () => this.db.tx((c) => this.lab.expire(c))).catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
    }
    if (total) this.log.log(`expired ${total} unpaid lab booking(s)`);
    return total;
  }
}
