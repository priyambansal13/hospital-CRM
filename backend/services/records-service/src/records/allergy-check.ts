/**
 * Does a prescribed medicine clash with a recorded allergy? (docs/ROLE-FLOWS-AND-GAPS.md C-3) Deterministic and
 * deliberately cautious: a direct name match, or the medicine belongs to the allergy's drug class (penicillin →
 * amoxicillin…). It is a safety net, not a drug database: the full interaction check is Phase 25.
 */
const CLASSES: Record<string, string[]> = {
  penicillin: ['penicillin', 'amoxicillin', 'amoxycillin', 'ampicillin', 'augmentin', 'amoxyclav', 'clavam', 'cloxacillin', 'dicloxacillin', 'flucloxacillin', 'piperacillin'],
  cephalosporin: ['cef', 'ceph'],
  sulfa: ['sulfa', 'sulpha', 'sulfamethoxazole', 'cotrimoxazole', 'co-trimoxazole', 'septran', 'bactrim', 'sulfasalazine'],
  nsaid: ['ibuprofen', 'diclofenac', 'aspirin', 'naproxen', 'ketorolac', 'combiflam', 'nimesulide', 'mefenamic', 'meftal', 'aceclofenac', 'indomethacin', 'piroxicam', 'etoricoxib', 'brufen', 'voveran', 'disprin', 'ecosprin'],
  aspirin: ['aspirin', 'disprin', 'ecosprin', 'acetylsalicylic'],
  paracetamol: ['paracetamol', 'acetaminophen', 'crocin', 'dolo', 'calpol', 'pacimol'],
  macrolide: ['azithromycin', 'erythromycin', 'clarithromycin', 'azee', 'azithral'],
  quinolone: ['ciprofloxacin', 'levofloxacin', 'ofloxacin', 'norfloxacin', 'moxifloxacin', 'floxacin'],
  tetracycline: ['tetracycline', 'doxycycline', 'minocycline'],
  opioid: ['codeine', 'morphine', 'tramadol', 'tapentadol', 'fentanyl'],
  iodine: ['iodine', 'povidone', 'betadine'],
};
// how people record the allergy → the class
const ALIASES: [RegExp, string][] = [
  [/penicil|amoxi|ampicil/i, 'penicillin'], [/cephalo|cef/i, 'cephalosporin'], [/sulf|sulph/i, 'sulfa'],
  [/nsaid|ibuprofen|diclofenac|painkiller/i, 'nsaid'], [/aspirin/i, 'aspirin'], [/paracetamol|acetaminophen/i, 'paracetamol'],
  [/macrolide|azithro|erythro/i, 'macrolide'], [/quinolone|floxacin/i, 'quinolone'], [/tetracycl|doxycycl/i, 'tetracycline'],
  [/opioid|codeine|morphine|tramadol/i, 'opioid'], [/iodine|betadine/i, 'iodine'],
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export interface Allergy { substance: string; severity: string }
export interface Conflict { drug: string; substance: string; severity: string }

export function allergyConflicts(drugs: string[], allergies: Allergy[]): Conflict[] {
  const out: Conflict[] = [];
  for (const d of drugs) {
    const drug = norm(d);
    for (const a of allergies) {
      const sub = norm(a.substance);
      if (sub.length < 3) continue;
      const direct = drug.includes(sub) || (drug.length >= 4 && sub.includes(drug.split(' ')[0]));
      const cls = ALIASES.filter(([re]) => re.test(a.substance)).map(([, c]) => c);
      const inClass = cls.some((c) => CLASSES[c].some((m) => drug.split(' ').some((w) => w.startsWith(m))));
      if (direct || inClass) out.push({ drug: d, substance: a.substance, severity: a.severity });
    }
  }
  return out;
}
