import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor, UseInterceptors, applyDecorators } from '@nestjs/common';
import { RequestContext } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { from, of, type Observable, switchMap, tap, catchError, throwError } from 'rxjs';
import { DomainError } from './errors.js';
import { REDIS, type Redis } from './redis.js';

const TTL_S = 24 * 3600;

/**
 * Idempotency-Key support for POST handlers (docs/LLD.md §16). Keyed per tenant + actor + key; a replay with the
 * same body returns the stored response, the same key with a different body is rejected. Redis-backed for M1.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const reply = ctx.switchToHttp().getResponse();
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) return next.handle();
    if (key.length > 100) throw new DomainError(400, 'BAD_IDEMPOTENCY_KEY', 'Idempotency-Key too long');
    const rc = RequestContext.current();
    const redisKey = `idem:${rc?.tenant?.id ?? '-'}:${rc?.actor?.id ?? '-'}:${req.method}:${req.url}:${key}`;
    const hash = createHash('sha256').update(JSON.stringify(req.body ?? null)).digest('hex');

    return from(this.redis.set(redisKey, JSON.stringify({ state: 'pending', hash }), 'EX', TTL_S, 'NX')).pipe(
      switchMap((ok) => {
        if (ok) {
          return next.handle().pipe(
            tap((body) => void this.redis.set(redisKey, JSON.stringify({ state: 'done', hash, status: reply.statusCode ?? 201, body }), 'EX', TTL_S)),
            catchError((e) => from(this.redis.del(redisKey)).pipe(switchMap(() => throwError(() => e)))),
          );
        }
        return from(this.redis.get(redisKey)).pipe(
          switchMap((raw) => {
            const prev = raw ? JSON.parse(raw) : undefined;
            if (!prev) return next.handle();
            if (prev.hash !== hash) throw new DomainError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
            if (prev.state === 'pending') throw new DomainError(409, 'REQUEST_IN_PROGRESS', 'a request with this Idempotency-Key is still running');
            reply.status(prev.status).header('idempotent-replayed', 'true');
            return of(prev.body);
          }),
        );
      }),
    );
  }
}

export const Idempotent = () => applyDecorators(UseInterceptors(IdempotencyInterceptor));
