import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

export const REDIS = Symbol('REDIS');

/**
 * Bounded waits (chaos tests, Phase 30): while Redis is unreachable a command fails within REDIS_COMMAND_TIMEOUT_MS
 * (default 1 s) instead of waiting in the client's queue, so callers answer 503 at once rather than hanging; the client
 * keeps reconnecting in the background and everything works again when Redis returns.
 */
export function createRedis() {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:61379', {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? 1000),
    connectTimeout: 2000,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  // one line when the connection drops and one when it is back (without a listener ioredis prints every retry)
  const log = new Logger('Redis');
  let down = false;
  client.on('error', (e) => { if (!down) { down = true; log.warn(`unreachable: ${e.message}`); } });
  client.on('ready', () => { if (down) { down = false; log.log('reachable again'); } });
  return client;
}

/** Errors that mean "Redis is unreachable right now" (mapped to 503 DEPENDENCY_UNAVAILABLE). */
export function isRedisUnavailable(e: unknown): boolean {
  const name = (e as Error)?.name ?? '';
  const msg = (e as Error)?.message ?? '';
  return name === 'MaxRetriesPerRequestError' || /^Command timed out$|Connection is closed|Stream isn't writeable|Reached the max retries per request/.test(msg);
}
export type { Redis };
