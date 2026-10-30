import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { BillingService } from './billing.service.js';
import { PaymentAccountService } from './payment-account.service.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;

/** Sends queued refunds to the gateway every few seconds, per hospital (sharded across replicas). */
@Injectable()
export class RefundJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('RefundJob');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly billing: BillingService, private readonly accounts: PaymentAccountService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => void this.runOnce(), Number(process.env.REFUND_INTERVAL_MS ?? 3_000));
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce() {
    if (this.running) return 0;
    this.running = true;
    let total = 0;
    try {
      const n = Number(process.env.REPLICA_COUNT ?? 1);
      const i = Number(process.env.REPLICA_INDEX ?? 0);
      for (const t of await this.placements.list()) {
        if (t.status !== 'ACTIVE' || shardOf(t.id, n) !== i) continue;
        total += await TenantContext.run(t, () => this.billing.submitRefunds()).catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
        // payouts held after a payout account change (review B-5) go out once the hold ends
        await TenantContext.run(t, () => this.accounts.releaseHeld()).catch((e) => this.log.warn(`${t.slug}: release held payouts: ${(e as Error).message}`));
      }
      if (total) this.log.log(`submitted ${total} refund(s)`);
    } catch (e) {
      this.log.warn(`refund run failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return total;
  }
}
