import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { AuditService } from './audit.service.js';

/** Re-checks every hospital's chain once a day (and shortly after start); a break is logged as an error to alert on. */
@Injectable()
export class VerifyJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('AuditVerify');
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: TenantDbRouter, private readonly audit: AuditService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    const run = () => this.runOnce().catch((e) => this.log.warn(`verify failed: ${(e as Error).message}`));
    setTimeout(run, 30_000);
    this.timer = setInterval(run, Number(process.env.AUDIT_VERIFY_INTERVAL_MS ?? 24 * 3_600_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async runOnce() {
    for (const t of await this.placements.list()) {
      if (t.status !== 'ACTIVE') continue;
      const r = await TenantContext.run(t, async () => this.audit.verify(await this.db.current()));
      if (r.ok) this.log.log(`${t.slug}: chain ok (${r.checked} entries)`);
      else this.log.error(`${t.slug}: AUDIT CHAIN BROKEN at entry ${r.firstBrokenId}: ${r.problem}`);
    }
  }
}
