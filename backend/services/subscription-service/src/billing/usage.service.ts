import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { type BillingNotice, EventTypes, Topics } from '@mc/contracts';
import { USAGE_KEYS, usageKey, usageMonth } from '@mc/entitlements-sdk';
import { CONTROL_DB, REDIS, type Redis } from '@mc/nest-common';
import { addToOutbox, envelope, withTx } from '@mc/tenancy';
import type pg from 'pg';
import { PlansService } from '../plans.service.js';

const KEY = /^usage:([0-9a-f-]{36}):([a-z_]+\.[a-z_]+):(\d{4}-\d{2})$/;

/**
 * Usage metering, the database side (docs/FEATURES-AND-PLANS.md §5.3): services count in Redis (UsageMeter); every
 * 30 s the counters are copied to usage_counters (invoices bill from there), and 80% / 100% of an allowance sends
 * the account owner one e-mail each per month.
 */
@Injectable()
export class UsageService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Usage');
  private timer?: NodeJS.Timeout;

  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool, @Inject(REDIS) private readonly redis: Redis, private readonly plans: PlansService) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => void this.flush().catch((e) => this.log.warn(`usage flush: ${(e as Error).message}`)), Number(process.env.USAGE_FLUSH_MS ?? 30_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  /** Copy counters to the database (one hospital, or all) and raise threshold alerts. */
  async flush(onlyTenant?: string) {
    const keys = (await this.redis.smembers(USAGE_KEYS)).filter((k) => !onlyTenant || k.startsWith(`usage:${onlyTenant}:`));
    let n = 0;
    for (const key of keys) {
      const m = KEY.exec(key);
      if (!m) { await this.redis.srem(USAGE_KEYS, key); continue; }
      const [, tenantId, feature, month] = m;
      const raw = await this.redis.get(key);
      if (raw == null) { await this.redis.srem(USAGE_KEYS, key); continue; } // expired after it was flushed
      const used = Math.max(0, Number(raw));
      await withTx(this.db, async (c) => {
        await c.query(`INSERT INTO usage_counters (tenant_id, feature_key, month, used) VALUES ($1,$2,$3,$4)
          ON CONFLICT (tenant_id, feature_key, month) DO UPDATE SET used = GREATEST(usage_counters.used, EXCLUDED.used), updated_at = now() WHERE usage_counters.billed_invoice_id IS NULL`,
          [tenantId, feature, `${month}-01`, used]);
        await this.alerts(c, tenantId, feature, `${month}-01`, used);
      }).catch((e) => this.log.warn(`${key}: ${(e as Error).message}`));
      n++;
    }
    return n;
  }

  private async alerts(c: pg.PoolClient, tenantId: string, feature: string, month: string, used: number) {
    const cur = await this.plans.current(tenantId, c).catch(() => null);
    const limit = cur?.effective.features[feature]?.limit;
    if (limit == null || limit <= 0) return;
    for (const threshold of [80, 100] as const) {
      if (used * 100 < limit * threshold) continue;
      const { rowCount } = await c.query(`INSERT INTO usage_alerts (tenant_id, feature_key, month, threshold, used) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [tenantId, feature, month, threshold, used]);
      if (!rowCount) continue;
      const data: BillingNotice = { kind: threshold === 80 ? 'USAGE_80' : 'USAGE_100', feature, used, limit, invoiceNo: null, amount: null, date: null, dedupe: `usage:${feature}:${month}:${threshold}` };
      await addToOutbox(c, Topics.subscription, tenantId, envelope(EventTypes.billingNotice, data, { tenantId }));
      this.log.log(`${await this.plans.slug(tenantId)}: ${feature} at ${threshold}% (${used}/${limit})`);
    }
  }

  /** DEV (billing test clock): forget a hospital's usage so a test run starts from zero. */
  async clear(tenantId: string) {
    for (const k of (await this.redis.smembers(USAGE_KEYS)).filter((x) => x.startsWith(`usage:${tenantId}:`))) {
      await this.redis.del(k);
      await this.redis.srem(USAGE_KEYS, k);
    }
    await this.db.query('DELETE FROM usage_alerts WHERE tenant_id = $1', [tenantId]);
    await this.db.query('DELETE FROM usage_counters WHERE tenant_id = $1', [tenantId]);
  }

  /** Meters for the account zone: this month live from Redis, earlier months from the database. */
  async meters(tenantId: string) {
    const cur = await this.plans.current(tenantId);
    const metered = [...this.plans.modules.modules.values()].flatMap((m) => m.features.filter((f) => f.type === 'METERED' && cur.effective.features[f.key]));
    const month = usageMonth();
    const out = [];
    for (const f of metered) {
      const eff = cur.effective.features[f.key];
      const live = Number((await this.redis.get(usageKey(tenantId, f.key, month))) ?? 0);
      const { rows } = await this.db.query(`SELECT to_char(month, 'YYYY-MM') AS m, used, billed_invoice_id IS NOT NULL AS billed FROM usage_counters WHERE tenant_id = $1 AND feature_key = $2 AND month < $3 ORDER BY month DESC LIMIT 6`, [tenantId, f.key, `${month}-01`]);
      out.push({ key: f.key, name: f.name, unit: f.unit ?? '', month, used: live, limit: eff.limit, overage: eff.overage, percent: eff.limit ? Math.round((live / eff.limit) * 100) : null, history: rows.map((r) => ({ month: r.m, used: Number(r.used), billed: r.billed })) });
    }
    return out;
  }
}
