import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { DocumentsService } from './documents.service.js';
import { ScribeService } from '../prescribing/prescribing.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;

/** Scans newly uploaded documents every couple of seconds, per hospital (sharded across replicas). */
@Injectable()
export class ScanJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('ScanJob');
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastPurge = 0;
  constructor(private readonly docs: DocumentsService, private readonly scribe: ScribeService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => void this.runOnce(), Number(process.env.SCAN_INTERVAL_MS ?? 2_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async runOnce() {
    if (this.running) return 0;
    this.running = true;
    let total = 0;
    try {
      const n = Number(process.env.REPLICA_COUNT ?? 1);
      const i = Number(process.env.REPLICA_INDEX ?? 0);
      // removed documents past their grace period, once an hour (review H-5)
      const purge = Date.now() - this.lastPurge > 3_600_000;
      if (purge) this.lastPurge = Date.now();
      for (const t of await this.placements.list()) {
        if (t.status !== 'ACTIVE' || shardOf(t.id, n) !== i) continue;
        total += await TenantContext.run(t, () => this.docs.scanPending()).catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
        if (purge) {
          const gone = await TenantContext.run(t, () => this.docs.purgeRemoved()).catch((e) => { this.log.warn(`${t.slug}: purge: ${(e as Error).message}`); return 0; });
          if (gone) this.log.log(`${t.slug}: ${gone} removed document(s) deleted for good`);
          // scribe recordings never outlive SCRIBE_AUDIO_HOURS, even if the visit is never signed
          const audio = await TenantContext.run(t, () => this.scribe.purge({ olderThanHours: Number(process.env.SCRIBE_AUDIO_HOURS ?? 24) }, 'EXPIRED')).catch(() => 0);
          if (audio) this.log.log(`${t.slug}: ${audio} consultation recording(s) deleted (older than the limit)`);
        }
      }
      if (total) this.log.log(`scanned ${total} document(s)`);
    } catch (e) {
      this.log.warn(`scan run failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return total;
  }
}
