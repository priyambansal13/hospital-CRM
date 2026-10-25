import { describe, expect, it } from 'vitest';
import { doctorQuery, testQuery } from './search.controller.js';
import { DOCTOR_SYNONYMS, INDEX_VERSION, TEST_SYNONYMS } from './synonyms.js';

describe('synonyms', () => {
  it.each([...DOCTOR_SYNONYMS, ...TEST_SYNONYMS])('"%s" is a one-way rule with words on both sides', (rule) => {
    const [from, to] = rule.split('=>');
    expect(to).toBeDefined();
    expect(from.split(',').every((w) => w.trim())).toBe(true);
    expect(to.split(',').every((w) => w.trim())).toBe(true);
    expect(rule).toBe(rule.toLowerCase());
  });

  it('a symptom is never mapped to two different single specialties in two rules', () => {
    const seen = new Map<string, string>();
    for (const rule of DOCTOR_SYNONYMS) {
      const [from, to] = rule.split('=>');
      for (const w of from.split(',').map((x) => x.trim())) {
        expect(seen.get(w) ?? to, `"${w}"`).toBe(to);
        seen.set(w, to);
      }
    }
  });

  it('the index version is a stable hash of the definitions', () => {
    expect(INDEX_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('doctor query', () => {
  it('without words: everyone matching the filters, soonest available first', () => {
    const q = doctorQuery({ specialty: 'CARDIOLOGY', limit: 20 });
    expect(q.query.bool).toEqual({ filter: [{ term: { specialtyCodes: 'CARDIOLOGY' } }] });
    expect(q.sort[1]).toEqual({ nextSort: 'asc' });
  });

  it('with words: at least one of specialty / name / keywords must match; filters still apply', () => {
    const q = doctorQuery({ q: 'chest pain', language: 'hi', limit: 20 });
    const b = q.query.bool as { should: unknown[]; minimum_should_match: number; filter: unknown[] };
    expect(b.minimum_should_match).toBe(1);
    expect(b.filter).toEqual([{ term: { languages: 'hi' } }]);
    expect(JSON.stringify(b.should)).toContain('"specialties"');
    // the fuzzy name clause uses the analyzer without synonyms
    expect(JSON.stringify(b.should)).toContain('"fuzziness":"AUTO","analyzer":"mc_text"');
    expect(q.sort[0]).toEqual({ _score: 'desc' });
  });
});

describe('test query', () => {
  it('exact code match ranks highest', () => {
    const q = testQuery('hba1c') as any;
    expect(q.query.bool.should[0]).toEqual({ constant_score: { filter: { term: { code: 'HBA1C' } }, boost: 20 } });
  });
  it('no words: the whole catalog', () => {
    expect(testQuery(undefined).query).toEqual({ match_all: {} });
  });
});
