import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import type pg from 'pg';
import { Public } from './auth/auth.js';
import { CONTROL_DB } from './tokens.js';
import { REDIS, type Redis } from './redis.js';

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
   * Readiness: can this instance serve requests now (control database, Redis)? 503 takes it out of the load balancer
   * until they are back. Kafka is not checked: the outbox keeps events until it returns.
   */
  @Get('ready')
  @Public()
  async ready() {
    const { ok, checks } = await this.checks();
    if (!ok) throw new ServiceUnavailableException({ status: 'down', service: process.env.SERVICE_NAME, checks });
    return { status: 'up', service: process.env.SERVICE_NAME, checks };
  }
}
