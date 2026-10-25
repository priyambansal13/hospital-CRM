import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { EntitlementsService } from './entitlements.service.js';

const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;

/**
 * Finishes module switches (docs/PRODUCT-MODULES-AND-PLANS.md §8): for each ACTIVATING/DISABLING module, call the
 * enable/disable hook of every service in the manifest's `lifecycle` (idempotent), then mark it ACTIVE / READ_ONLY.
 * A failing hook is retried with backoff; the module stays "activating" in the admin UI meanwhile.
 */
@Injectable()
export class ModuleLifecycleJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('ModuleLifecycle');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly db: TenantDbRouter, private readonly svc: EntitlementsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => void this.runOnce().catch((e) => this.log.warn((e as Error).message)), Number(process.env.MODULE_LIFECYCLE_INTERVAL_MS ?? 2_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async runOnce() {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      const n = Number(process.env.REPLICA_COUNT ?? 1);
      const i = Number(process.env.REPLICA_INDEX ?? 0);
      for (const t of await this.placements.list()) {
        if ((t.status !== 'ACTIVE' && t.status !== 'READ_ONLY') || shardOf(t.id, n) !== i) continue;
        done += await TenantContext.run(t, () => this.runTenant(t.id)).catch((e) => { this.log.warn(`${t.slug}: ${(e as Error).message}`); return 0; });
      }
    } finally {
      this.running = false;
    }
    return done;
  }

  private async runTenant(tenantId: string) {
    const pending = await this.svc.pendingModules(await this.db.current());
    let done = 0;
    for (const p of pending) {
      const action = p.state === 'ACTIVATING' ? 'enable' : 'disable';
      try {
        for (const service of this.svc.catalog.modules.get(p.module_key)?.lifecycle ?? []) await this.callHook(service, tenantId, p.module_key, action);
        await this.db.tx((c) => this.svc.finishModule(c, p.module_key, p.state));
        this.log.log(`${TenantContext.require().slug}: module ${p.module_key} ${action}d`);
        done++;
      } catch (e) {
        const msg = (e as Error).message;
        this.log.warn(`${TenantContext.require().slug}: ${action} ${p.module_key} failed (attempt ${p.attempts + 1}): ${msg}`);
        await this.db.tx((c) => this.svc.retryModule(c, p.module_key, p.state, p.attempts, msg));
      }
    }
    return done;
  }

  private async callHook(service: string, tenantId: string, module: string, action: 'enable' | 'disable') {
    const base = process.env[`SVC_URL_${service.toUpperCase()}`];
    if (!base) throw new Error(`SVC_URL_${service.toUpperCase()} is not set`);
    const res = await fetch(`${base}/internal/tenants/${tenantId}/modules/${module}/${action}`, {
      method: 'POST',
      headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${service} ${action} hook → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
