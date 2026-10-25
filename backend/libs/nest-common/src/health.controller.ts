import { Controller, Get, Inject, Optional } from '@nestjs/common';
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

  @Get()
  @Public()
  async health() {
    const checks: Record<string, 'up' | 'down'> = {};
    if (this.control) checks.controlDb = await this.control.query('SELECT 1').then(() => 'up' as const, () => 'down' as const);
    if (this.redis) checks.redis = await this.redis.ping().then(() => 'up' as const, () => 'down' as const);
    const ok = Object.values(checks).every((v) => v === 'up');
    return { status: ok ? 'up' : 'degraded', service: process.env.SERVICE_NAME, checks };
  }
}
