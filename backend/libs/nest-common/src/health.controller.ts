import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import type pg from 'pg';
import { Public } from './auth/auth.js';
import { CONTROL_DB } from './tokens.js';
import { REDIS, type Redis } from './redis.js';
import { dependencyUp } from './metrics.js';

@Controller('health')
export class HealthController {
  constructor(
    @Optional() @Inject(CONTROL_DB) private readonly control?: pg.Pool,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  private async checks() {
    const checks: Record<string, 'up' | 'down'> = {};
    const timeout = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 2000))]);
    if (this.control) checks.controlDb = await timeout(this.control.query('SELECT 1')).then(() => 'up' as const, () => 'down' as const);
    if (this.redis) checks.redis = await timeout(this.redis.ping()).then(() => 'up' as const, () => 'down' as const);
    for (const [k, v] of Object.entries(checks)) dependencyUp.set({ dependency: k === 'controlDb' ? 'control_db' : k }, v === 'up' ? 1 : 0);
    return { ok: Object.values(checks).every((v) => v === 'up'), checks };
  }

  /** Summary for people and scripts (always 200; see /health/ready for the probe). */
  @Get()
  @Public()
  async health() {
    const { ok, checks } = await this.checks();
    return { status: ok ? 'up' : 'degraded', service: process.env.SERVICE_NAME, checks };
  }

  /** Liveness: the process answers (a dependency being down must not restart it). Review H-3. */
  @Get('live')
  @Public()
  live() {
    return { status: 'up' };
  }

  /**
   * Readiness: can this instance serve requests now? Only the control database decides. Redis and Kafka are shared by
   * every instance: taking all of them out of the load balancer when Redis is down would turn "some requests fail fast
   * with 503" into a full outage (chaos tests, Phase 30). Their state is reported here and on /health, and alerted on.
   */
  @Get('ready')
  @Public()
  async ready() {
    const { checks } = await this.checks();
    if (checks.controlDb === 'down') throw new ServiceUnavailableException({ status: 'down', service: process.env.SERVICE_NAME, checks });
    return { status: checks.redis === 'down' ? 'degraded' : 'up', service: process.env.SERVICE_NAME, checks };
  }
}
