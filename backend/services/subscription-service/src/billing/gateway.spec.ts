import { afterEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { DECLINING_CARD, ManualPayments, recurringGateway, simulateAuthorise, SimulatedCards } from './gateway.js';

const db = {} as pg.Pool;
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe('recurring gateway (review A-1)', () => {
  it('outside development, without SAAS_PAYMENTS, runs in manual (bank transfer) mode instead of crashing', () => {
    process.env.MC_DEV = 'false';
    delete process.env.SAAS_PAYMENTS;
    const g = recurringGateway(db);
    expect(g).toBeInstanceOf(ManualPayments);
    expect(g.takesCards).toBe(false);
  });

  it('development uses the simulated gateway; it refuses to run in production', () => {
    process.env.MC_DEV = 'true';
    delete process.env.SAAS_PAYMENTS;
    expect(recurringGateway(db)).toBeInstanceOf(SimulatedCards);
    process.env.MC_DEV = 'false';
    process.env.SAAS_PAYMENTS = 'simulated';
    expect(() => recurringGateway(db)).toThrow(/local development only/);
  });

  it('razorpay is not built yet, and an unknown mode is refused, both with a clear message', () => {
    process.env.SAAS_PAYMENTS = 'razorpay';
    expect(() => recurringGateway(db)).toThrow(/not built yet/);
    process.env.SAAS_PAYMENTS = 'stripe';
    expect(() => recurringGateway(db)).toThrow(/simulated, manual or razorpay/);
  });

  it('the simulated page keeps only brand and last 4 digits', () => {
    const m = simulateAuthorise({ number: '4111 1111 1111 1111', expiry: '12/30', name: 'A' });
    expect(m).toMatchObject({ brand: 'Visa', last4: '1111' });
    expect(JSON.stringify(m)).not.toContain('411111111111');
    expect(simulateAuthorise({ number: DECLINING_CARD, expiry: '12/30', name: 'A' }).mandateId).toMatch(/^mdt_decl/);
    expect(() => simulateAuthorise({ number: '4111 1111 1111 1112', expiry: '12/30', name: 'A' })).toThrow(/not valid/);
  });
});
