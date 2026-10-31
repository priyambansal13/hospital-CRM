import { describe, expect, it } from 'vitest';
import { scrub } from './tracing.js';

describe('trace attribute scrubbing', () => {
  it('drops query strings, which can hold a phone number or an e-mail', () => {
    const a: Record<string, unknown> = { 'url.full': 'http://localhost:4402/internal/tenants/x/staff?email=a%40b.test', 'http.target': '/v1/otp?phone=9999999999', 'url.query': 'phone=9999999999', 'http.route': '/v1/otp' };
    scrub(a);
    expect(a).toEqual({ 'url.full': 'http://localhost:4402/internal/tenants/x/staff', 'http.target': '/v1/otp', 'http.route': '/v1/otp' });
  });
});
