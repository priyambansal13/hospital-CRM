import { HttpException } from '@nestjs/common';
import { TenantNotFoundError } from '@mc/tenancy';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DomainError, ProblemFilter } from './errors.js';

function render(err: unknown) {
  let status = 0;
  let body: any;
  const reply = { status: (s: number) => { status = s; return reply; }, header: () => reply, send: (b: unknown) => { body = b; } };
  new ProblemFilter().catch(err, { switchToHttp: () => ({ getResponse: () => reply }) } as any);
  return { status, body };
}

describe('ProblemFilter (RFC 7807)', () => {
  it('maps domain, validation, tenant and http errors to stable codes', () => {
    expect(render(new DomainError(409, 'SLOT_UNAVAILABLE', 'taken', { alternatives: [] }))).toMatchObject({ status: 409, body: { code: 'SLOT_UNAVAILABLE', alternatives: [] } });
    const zerr = z.object({ a: z.string() }).safeParse({}).error!;
    expect(render(zerr)).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED', errors: [{ path: 'a' }] } });
    expect(render(new TenantNotFoundError('x'))).toMatchObject({ status: 404, body: { code: 'TENANT_NOT_FOUND' } });
    expect(render(new HttpException('nope', 404))).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect(render(new Error('boom'))).toMatchObject({ status: 500, body: { code: 'INTERNAL', detail: 'unexpected error' } });
  });
});
