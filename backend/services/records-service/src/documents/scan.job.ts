import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { DocumentsService } from './documents.service.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;

/** Scans newly uploaded documents every couple of seconds, per hospital (sharded across replicas). */
@Injectable()
export class ScanJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('ScanJob');
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly docs: DocumentsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

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
      for (const t of await this.placements.list()) {
        if (t.status !== 'ACTIVE' || shardOf(t.id, n) !== i) continue;
        total += await TenantContext.run(t, () => this.docs.scanPending()).catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
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
