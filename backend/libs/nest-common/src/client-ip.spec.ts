import { describe, expect, it } from 'vitest';
import { clientIp } from './client-ip.js';

describe('clientIp (review B-7)', () => {
  it('uses the address the gateway worked out (X-Real-IP), never the raw X-Forwarded-For', () => {
    expect(clientIp({ headers: { 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }, ip: '10.0.0.5' })).toBe('198.51.100.7');
    expect(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6' }, ip: '10.0.0.5' })).toBe('10.0.0.5');
    expect(clientIp({ headers: {} })).toBeNull();
  });
});
