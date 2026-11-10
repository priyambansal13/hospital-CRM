import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { GrowthService } from './growth.service.js';

/**
 * Every 10 minutes: record PAID for signups whose hospital has paid its first invoice, then send consented
 * conversions to Meta (when configured). One replica runs it; both steps are idempotent.
 */
@Injectable()
export class GrowthJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('GrowthJob');
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly growth: GrowthService) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true' || Number(process.env.REPLICA_INDEX ?? 0) !== 0) return;
    this.timer = setInterval(() => void this.runOnce(), Number(process.env.GROWTH_JOB_MS ?? 600_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  private async billing(path: string) {
    const res = await fetch(`${process.env.SVC_URL_SUBSCRIPTION ?? 'http://localhost:4413'}${path}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as { invoices: { total: number; paidAt: string | null }[] }) : null;
  }

  async runOnce() {
    if (this.running) return { paid: 0, meta: { sent: 0, configured: false } };
    this.running = true;
    try {
      const paid = await this.growth.findPaid((p) => this.billing(p));
      const meta = await this.growth.sendMeta();
      if (paid || meta.sent) this.log.log(`growth: ${paid} newly paying, ${meta.sent} sent to Meta`);
      return { paid, meta };
    } catch (e) {
      this.log.warn(`growth job failed: ${(e as Error).message}`);
      return { paid: 0, meta: { sent: 0, configured: false } };
    } finally {
      this.running = false;
    }
  }
}
