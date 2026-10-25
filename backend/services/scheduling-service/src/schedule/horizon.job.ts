import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { ScheduleService } from './schedule.service.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;

/**
 * Keeps every doctor's slots filled to the rolling horizon (docs/LLD.md §5.1). Runs at start-up and then hourly,
 * per hospital database, sharded across replicas like the outbox relay. Idempotent.
 */
@Injectable()
export class HorizonJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('HorizonJob');
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: TenantDbRouter, private readonly svc: ScheduleService, @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly entitlements: EntitlementsClient) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    const run = () => this.runOnce().catch((e) => this.log.warn(`horizon run failed: ${(e as Error).message}`));
    setTimeout(run, 2_000);
    this.timer = setInterval(run, Number(process.env.SLOT_HORIZON_INTERVAL_MS ?? 3_600_000));
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
      // no new slots where appointments is no longer in the plan (existing appointments stay readable)
      if ((await this.entitlements.moduleState(t.id, 'appointments').catch(() => 'OFF')) !== 'ACTIVE') continue;
      total += await TenantContext.run(t, () => this.db.tx(async (c) => {
        const { rows } = await c.query('SELECT DISTINCT doctor_id FROM availability_templates');
        let made = 0;
        for (const r of rows) {
          const k = await this.svc.generate(c, r.doctor_id);
          if (k) await this.svc.changed(c, r.doctor_id, 'horizon extended');
          made += k;
        }
        return made;
      })).catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
    }
    if (total) this.log.log(`generated ${total} slots`);
    return total;
  }
}
