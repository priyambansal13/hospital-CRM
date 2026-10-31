import { ALLERGY_WORDS, type AllergyGroup, CROSS_REACTIVE, type Drug, FORMULARY, INTERACTIONS, type Severity } from './drug-data.js';

/**
 * Deterministic prescription safety (Phase 25): allergy clashes, interactions and same-class duplicates, from data,
 * never from a model. Used when a prescription is issued (the doctor must give a reason to go ahead) and to check an
 * AI scribe draft before the doctor sees it.
 */
const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[^a-z0-9+ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The formulary entry a written drug name means ("Augmentin 625", "amoxicillin", "Tab. Dolo 650"), or null. */
export function matchDrug(name: string, formulary: Drug[] = FORMULARY): Drug | null {
  const n = ` ${norm(name)} `;
  // the longest name that appears as whole words wins ("amoxicillin clavulanic acid" over "amoxicillin")
  let best: { d: Drug; len: number } | null = null;
  for (const d of formulary) {
    for (const label of [d.generic, ...d.brands]) {
      const l = norm(label);
      if (l && n.includes(` ${l} `) && (!best || l.length > best.len)) best = { d, len: l.length };
    }
  }
  return best?.d ?? null;
}

export function allergyGroups(substance: string): AllergyGroup[] {
  return [...new Set(ALLERGY_WORDS.filter(([re]) => re.test(substance)).flatMap(([, g]) => g))];
}

export interface AllergyClash { drug: string; allergy: string; level: 'BLOCK' | 'CAUTION'; reason: string }
export interface InteractionHit { a: string; b: string; severity: Severity; effect: string; withCurrent: boolean }
export interface SafetyReport { unmatched: string[]; allergies: AllergyClash[]; interactions: InteractionHit[]; duplicates: { a: string; b: string; drugClass: string }[] }

const hits = (d: Drug, keys: string[]) => keys.includes(d.code) || keys.includes(d.drugClass);

export function checkPrescription(input: { items: { drugName: string }[]; allergies: { substance: string }[]; current?: { drugName: string }[]; formulary?: Drug[] }): SafetyReport {
  const f = input.formulary ?? FORMULARY;
  const items = input.items.map((i) => ({ name: i.drugName, drug: matchDrug(i.drugName, f) }));
  const current = (input.current ?? []).map((i) => ({ name: i.drugName, drug: matchDrug(i.drugName, f) })).filter((x) => x.drug && !items.some((i) => i.drug?.code === x.drug!.code));
  const report: SafetyReport = { unmatched: items.filter((i) => !i.drug).map((i) => i.name), allergies: [], interactions: [], duplicates: [] };

  for (const a of input.allergies) {
    const groups = allergyGroups(a.substance);
    for (const i of items) {
      // a direct name match counts too ("Allergy: Dolo" → paracetamol)
      const direct = !!i.drug && !!matchDrug(a.substance, [i.drug]);
      if (!i.drug && norm(i.name) && norm(a.substance) && norm(i.name).includes(norm(a.substance))) {
        report.allergies.push({ drug: i.name, allergy: a.substance, level: 'BLOCK', reason: 'the drug name contains the allergy' });
        continue;
      }
      if (!i.drug) continue;
      const same = i.drug.groups.find((g) => groups.includes(g));
      if (same || direct) { report.allergies.push({ drug: i.name, allergy: a.substance, level: 'BLOCK', reason: same ? `${i.drug.generic} is a ${same.toLowerCase()}` : `${i.drug.generic} is the allergy` }); continue; }
      const cross = CROSS_REACTIVE.find(([x, y]) => (groups.includes(x) && i.drug!.groups.includes(y)) || (groups.includes(y) && i.drug!.groups.includes(x)));
      if (cross) report.allergies.push({ drug: i.name, allergy: a.substance, level: 'CAUTION', reason: `possible cross-reaction (${cross[0].toLowerCase()} / ${cross[1].toLowerCase()})` });
    }
  }

  const pairs: { x: (typeof items)[number]; y: (typeof items)[number]; withCurrent: boolean }[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) pairs.push({ x: items[i], y: items[j], withCurrent: false });
    for (const c of current) pairs.push({ x: items[i], y: c, withCurrent: true });
  }
  for (const { x, y, withCurrent } of pairs) {
    if (!x.drug || !y.drug) continue;
    for (const r of INTERACTIONS) {
      if ((hits(x.drug, r.a) && hits(y.drug, r.b)) || (hits(x.drug, r.b) && hits(y.drug, r.a))) {
        report.interactions.push({ a: x.name, b: y.name, severity: r.severity, effect: r.effect, withCurrent });
        break;
      }
    }
    if (!withCurrent && x.drug.drugClass === y.drug.drugClass) report.duplicates.push({ a: x.name, b: y.name, drugClass: x.drug.drugClass });
  }
  return report;
}

/** What needs the doctor's written reason before the prescription can be issued. */
export const needsOverride = (r: SafetyReport) => r.allergies.some((a) => a.level === 'BLOCK') || r.interactions.some((i) => i.severity === 'MAJOR');
