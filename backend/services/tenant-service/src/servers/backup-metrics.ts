import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CONTROL_DB, Gauge, metrics } from '@mc/nest-common';
import type pg from 'pg';
import { backupSummary } from './servers.controller.js';

/**
 * Backup health for the alerts (docs/OPERATIONS.md): read from the catalogue when Prometheus scrapes, one series per
 * open hospital (by slug). A hospital never backed up reports its age since it was created. Only one replica answers
 * the scrape the same way as any other, so no job is needed.
 */
@Injectable()
export class BackupMetrics implements OnModuleInit {
  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool) {}

  onModuleInit() {
    if (metrics.getSingleMetric('mc_backup_age_seconds')) return;
    let cache: { at: number; rows: any[] } = { at: 0, rows: [] };
    const rows = async () => {
      if (Date.now() - cache.at > 15_000) cache = { at: Date.now(), rows: await backupSummary(this.db).catch(() => cache.rows) };
      return cache.rows;
    };
    const created = new Map<string, number>();
    const db = this.db;
    new Gauge({
      name: 'mc_backup_age_seconds', help: "Seconds since the hospital's latest backup started (since creation if never backed up)", labelNames: ['tenant', 'server'], registers: [metrics],
      async collect() {
        this.reset();
        const list = await rows();
        const missing = list.filter((r) => !r.started_at && !created.has(r.tenant_id)).map((r) => r.tenant_id);
        if (missing.length) for (const r of (await db.query('SELECT id, created_at FROM tenants WHERE id = ANY($1)', [missing])).rows) created.set(r.id, +new Date(r.created_at));
        for (const r of list) this.set({ tenant: r.slug, server: r.db_server ?? '' }, Math.round((Date.now() - (r.started_at ? +new Date(r.started_at) : created.get(r.tenant_id) ?? Date.now())) / 1000));
      },
    });
    new Gauge({
      name: 'mc_backup_drill_ok', help: '1 when the latest restore drill matched its backup, 0 when it failed (no series before the first drill)', labelNames: ['tenant'], registers: [metrics],
      async collect() { this.reset(); for (const r of await rows()) if (r.drill_at) this.set({ tenant: r.slug }, r.drill_ok ? 1 : 0); },
    });
    new Gauge({
      name: 'mc_backup_drill_age_seconds', help: "Seconds since the hospital's latest restore drill", labelNames: ['tenant'], registers: [metrics],
      async collect() { this.reset(); for (const r of await rows()) if (r.drill_at) this.set({ tenant: r.slug }, Math.round((Date.now() - +new Date(r.drill_at)) / 1000)); },
    });
  }
}
