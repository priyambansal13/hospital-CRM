import { Redis } from 'ioredis';

export const REDIS = Symbol('REDIS');

export function createRedis() {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:61379', { lazyConnect: false, maxRetriesPerRequest: 3 });
}
export type { Redis };
