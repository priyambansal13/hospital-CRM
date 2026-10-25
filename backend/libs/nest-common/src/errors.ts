import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Problem } from '@mc/contracts';
import { RequestContext, TenantNotFoundError, TenantRoutingError, TenantUnavailableError, NoTenantContextError } from '@mc/tenancy';
import { ZodError } from 'zod';

/** Throw this for every expected failure; it becomes an RFC 7807 problem response with a stable `code`. */
export class DomainError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export const notFound = (what = 'resource') => new DomainError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (code = 'FORBIDDEN', msg = 'not allowed') => new DomainError(403, code, msg);
export const conflict = (code: string, msg: string, extra?: Record<string, unknown>) => new DomainError(409, code, msg, extra);

const titles: Record<number, string> = { 400: 'Bad request', 401: 'Unauthenticated', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 422: 'Unprocessable', 429: 'Too many requests', 500: 'Internal error', 503: 'Unavailable' };

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Problem');

  catch(err: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse();
    const p = this.toProblem(err);
    p.requestId = RequestContext.current()?.requestId;
    if (p.status >= 500) this.log.error({ msg: (err as Error)?.message, stack: (err as Error)?.stack, requestId: p.requestId });
    reply.status(p.status).header('content-type', 'application/problem+json').send(p);
  }

  private toProblem(err: unknown): Problem {
    const make = (status: number, code: string, detail?: string, extra: Record<string, unknown> = {}): Problem => ({
      type: `https://medicare.example/errors/${code.toLowerCase().replaceAll('_', '-')}`,
      title: titles[status] ?? 'Error', status, code, detail, ...extra,
    });
    if (err instanceof DomainError) return make(err.status, err.code, err.message, err.extra);
    if (err instanceof ZodError) return make(400, 'VALIDATION_FAILED', 'request validation failed', { errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof TenantNotFoundError) return make(404, 'TENANT_NOT_FOUND', 'unknown hospital');
    if (err instanceof TenantUnavailableError) return make(503, 'TENANT_UNAVAILABLE', `hospital is ${err.status}`);
    if (err instanceof TenantRoutingError || err instanceof NoTenantContextError) return make(500, 'TENANT_ROUTING', 'internal tenant routing error');
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const body = err.getResponse() as any;
      return make(status, body?.code ?? (status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'HTTP_' + status), typeof body === 'string' ? body : body?.message);
    }
    return make(500, 'INTERNAL', 'unexpected error');
  }
}
