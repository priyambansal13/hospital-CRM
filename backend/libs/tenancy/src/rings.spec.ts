import { describe, expect, it } from 'vitest';
import { planRings, type PlanTenant } from './migrate.js';

const t = (slug: string, ring: number, server = 'pg-1'): PlanTenant => ({ id: slug, slug, dbName: `t_${slug}`, ring, server });

describe('planRings', () => {
  it('runs internal hospitals first, then pilots, then everyone, then dedicated servers', () => {
    const rings = planRings([t('a', 2), t('internal', 0), t('pilot', 1), t('big', 3, 'pg-9'), t('b', 2)]);
    expect(rings.map((r) => r.flat().map((x) => x.slug))).toEqual([['internal'], ['pilot'], ['a', 'b'], ['big']]);
  });

  it('holds back rings above maxRing (dedicated servers wait for their window)', () => {
    expect(planRings([t('a', 2), t('big', 3)], { maxRing: 2 }).flat(2).map((x) => x.slug)).toEqual(['a']);
  });

  it('limits each batch per server, filling it from other servers', () => {
    const many = [...Array.from({ length: 6 }, (_, i) => t(`a${i}`, 2, 'pg-1')), t('b0', 2, 'pg-2'), t('b1', 2, 'pg-2')];
    const [, , general] = planRings(many, { size: 5, perServer: 3 });
    expect(general.map((b) => b.map((x) => x.slug))).toEqual([['a0', 'a1', 'a2', 'b0', 'b1'], ['a3', 'a4', 'a5']]);
    expect(general.flat()).toHaveLength(8);
  });
});
