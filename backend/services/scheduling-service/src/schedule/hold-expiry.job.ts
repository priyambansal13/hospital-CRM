import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { AppointmentsService } from './appointments.service.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;

/**
 * Online bookings whose payment never arrived: every 30 s, per hospital database (sharded across replicas),
 * PENDING_PAYMENT past its hold → EXPIRED and the slot reopens (docs/LLD.md §5.4). A payment that still arrives later
 * re-takes the slot if it is free, or is refunded (AppointmentsService.onPaymentSucceeded).
 */
@Injectable()
export class HoldExpiryJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('HoldExpiryJob');
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: TenantDbRouter, private readonly appts: AppointmentsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => this.runOnce().catch((e) => this.log.warn(`hold expiry failed: ${(e as Error).message}`)), Number(process.env.HOLD_EXPIRY_INTERVAL_MS ?? 30_000));
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
      total += await TenantContext.run(t, () => this.db.tx((c) => this.appts.expire(c)))
        .catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
    }
    if (total) this.log.log(`expired ${total} unpaid hold(s)`);
    return total;
  }
}
