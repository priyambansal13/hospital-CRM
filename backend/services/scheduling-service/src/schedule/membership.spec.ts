import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { membersOnly } from './membership.js';

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000);

describe('members-only times', () => {
  const ids = Array.from({ length: 2000 }, () => randomUUID());
  it('holds about the configured share, and the same slot always gets the same answer', () => {
    const held = ids.filter((id) => membersOnly(id, inDays(5), 20)).length;
    expect(held / ids.length).toBeGreaterThan(0.15);
    expect(held / ids.length).toBeLessThan(0.25);
    expect(ids.map((id) => membersOnly(id, inDays(5), 20))).toEqual(ids.map((id) => membersOnly(id, inDays(5), 20)));
  });
  it('opens everything within 24 hours, and nothing is held at 0%', () => {
    expect(ids.some((id) => membersOnly(id, inDays(0.9), 50))).toBe(false);
    expect(ids.some((id) => membersOnly(id, inDays(5), 0))).toBe(false);
  });
});
