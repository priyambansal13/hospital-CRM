/**
 * The starting formulary and the deterministic safety rules (IMPLEMENTATION-PLAN.md Phase 25, docs/AI-AGENTS.md §5.1
 * "Prescription safety"). The model never decides these: allergy clashes and interactions come from this data.
 *
 * IMPORTANT: this is a small starter set for development and demos, written from common prescribing knowledge. Before
 * clinical use it must be replaced or backed by a licensed, maintained drug database (e.g. CIMS, Medi-Span, First
 * Databank) and reviewed by the hospital's pharmacy and therapeutics committee. Hospitals can extend their own
 * formulary (records.formulary); the interaction rules here are global.
 */

/** Allergy groups: an allergy to one member is a clash with every drug in the group. */
export type AllergyGroup = 'PENICILLIN' | 'CEPHALOSPORIN' | 'SULFONAMIDE' | 'NSAID' | 'MACROLIDE' | 'FLUOROQUINOLONE' | 'OPIOID' | 'TETRACYCLINE';

export interface Drug { code: string; generic: string; brands: string[]; drugClass: string; groups: AllergyGroup[]; forms: string[]; strengths: string[] }

export const FORMULARY: Drug[] = [
  { code: 'AMOXICILLIN', generic: 'Amoxicillin', brands: ['Mox', 'Novamox'], drugClass: 'PENICILLIN', groups: ['PENICILLIN'], forms: ['capsule', 'syrup'], strengths: ['250 mg', '500 mg'] },
  { code: 'AMOXICLAV', generic: 'Amoxicillin + Clavulanic acid', brands: ['Augmentin', 'Clavam'], drugClass: 'PENICILLIN', groups: ['PENICILLIN'], forms: ['tablet', 'syrup'], strengths: ['625 mg', '375 mg'] },
  { code: 'CLOXACILLIN', generic: 'Cloxacillin', brands: [], drugClass: 'PENICILLIN', groups: ['PENICILLIN'], forms: ['capsule'], strengths: ['250 mg', '500 mg'] },
  { code: 'CEFIXIME', generic: 'Cefixime', brands: ['Taxim-O', 'Zifi'], drugClass: 'CEPHALOSPORIN', groups: ['CEPHALOSPORIN'], forms: ['tablet', 'syrup'], strengths: ['200 mg', '100 mg'] },
  { code: 'CEPHALEXIN', generic: 'Cephalexin', brands: ['Sporidex'], drugClass: 'CEPHALOSPORIN', groups: ['CEPHALOSPORIN'], forms: ['capsule'], strengths: ['250 mg', '500 mg'] },
  { code: 'AZITHROMYCIN', generic: 'Azithromycin', brands: ['Azithral', 'Azee'], drugClass: 'MACROLIDE', groups: ['MACROLIDE'], forms: ['tablet', 'syrup'], strengths: ['250 mg', '500 mg'] },
  { code: 'CLARITHROMYCIN', generic: 'Clarithromycin', brands: ['Claribid'], drugClass: 'MACROLIDE', groups: ['MACROLIDE'], forms: ['tablet'], strengths: ['250 mg', '500 mg'] },
  { code: 'CIPROFLOXACIN', generic: 'Ciprofloxacin', brands: ['Ciplox', 'Cifran'], drugClass: 'FLUOROQUINOLONE', groups: ['FLUOROQUINOLONE'], forms: ['tablet'], strengths: ['250 mg', '500 mg'] },
  { code: 'LEVOFLOXACIN', generic: 'Levofloxacin', brands: ['Levoflox'], drugClass: 'FLUOROQUINOLONE', groups: ['FLUOROQUINOLONE'], forms: ['tablet'], strengths: ['500 mg', '750 mg'] },
  { code: 'DOXYCYCLINE', generic: 'Doxycycline', brands: ['Doxy-1'], drugClass: 'TETRACYCLINE', groups: ['TETRACYCLINE'], forms: ['capsule'], strengths: ['100 mg'] },
  { code: 'COTRIMOXAZOLE', generic: 'Cotrimoxazole', brands: ['Septran', 'Bactrim'], drugClass: 'SULFONAMIDE', groups: ['SULFONAMIDE'], forms: ['tablet'], strengths: ['480 mg', '960 mg'] },
  { code: 'METRONIDAZOLE', generic: 'Metronidazole', brands: ['Flagyl', 'Metrogyl'], drugClass: 'NITROIMIDAZOLE', groups: [], forms: ['tablet'], strengths: ['200 mg', '400 mg'] },
  { code: 'FLUCONAZOLE', generic: 'Fluconazole', brands: ['Forcan'], drugClass: 'AZOLE', groups: [], forms: ['tablet'], strengths: ['150 mg'] },
  { code: 'PARACETAMOL', generic: 'Paracetamol', brands: ['Crocin', 'Dolo', 'Calpol'], drugClass: 'ANALGESIC', groups: [], forms: ['tablet', 'syrup'], strengths: ['500 mg', '650 mg'] },
  { code: 'IBUPROFEN', generic: 'Ibuprofen', brands: ['Brufen'], drugClass: 'NSAID', groups: ['NSAID'], forms: ['tablet', 'syrup'], strengths: ['200 mg', '400 mg'] },
  { code: 'DICLOFENAC', generic: 'Diclofenac', brands: ['Voveran'], drugClass: 'NSAID', groups: ['NSAID'], forms: ['tablet', 'gel'], strengths: ['50 mg', '75 mg'] },
  { code: 'NAPROXEN', generic: 'Naproxen', brands: ['Naprosyn'], drugClass: 'NSAID', groups: ['NSAID'], forms: ['tablet'], strengths: ['250 mg', '500 mg'] },
  { code: 'ASPIRIN', generic: 'Aspirin', brands: ['Ecosprin', 'Disprin'], drugClass: 'NSAID', groups: ['NSAID'], forms: ['tablet'], strengths: ['75 mg', '150 mg', '325 mg'] },
  { code: 'TRAMADOL', generic: 'Tramadol', brands: ['Ultracet', 'Contramal'], drugClass: 'OPIOID', groups: ['OPIOID'], forms: ['tablet', 'capsule'], strengths: ['50 mg'] },
  { code: 'METFORMIN', generic: 'Metformin', brands: ['Glycomet', 'Glucophage'], drugClass: 'BIGUANIDE', groups: [], forms: ['tablet'], strengths: ['500 mg', '850 mg', '1000 mg'] },
  { code: 'GLIMEPIRIDE', generic: 'Glimepiride', brands: ['Amaryl'], drugClass: 'SULFONYLUREA', groups: [], forms: ['tablet'], strengths: ['1 mg', '2 mg'] },
  { code: 'AMLODIPINE', generic: 'Amlodipine', brands: ['Amlong', 'Stamlo'], drugClass: 'CCB', groups: [], forms: ['tablet'], strengths: ['2.5 mg', '5 mg', '10 mg'] },
  { code: 'TELMISARTAN', generic: 'Telmisartan', brands: ['Telma'], drugClass: 'ARB', groups: [], forms: ['tablet'], strengths: ['20 mg', '40 mg', '80 mg'] },
  { code: 'LOSARTAN', generic: 'Losartan', brands: ['Losar'], drugClass: 'ARB', groups: [], forms: ['tablet'], strengths: ['25 mg', '50 mg'] },
  { code: 'ENALAPRIL', generic: 'Enalapril', brands: ['Envas'], drugClass: 'ACE_INHIBITOR', groups: [], forms: ['tablet'], strengths: ['2.5 mg', '5 mg', '10 mg'] },
  { code: 'RAMIPRIL', generic: 'Ramipril', brands: ['Cardace'], drugClass: 'ACE_INHIBITOR', groups: [], forms: ['capsule'], strengths: ['2.5 mg', '5 mg'] },
  { code: 'SPIRONOLACTONE', generic: 'Spironolactone', brands: ['Aldactone'], drugClass: 'K_SPARING_DIURETIC', groups: [], forms: ['tablet'], strengths: ['25 mg', '50 mg'] },
  { code: 'ATORVASTATIN', generic: 'Atorvastatin', brands: ['Atorva', 'Lipitor'], drugClass: 'STATIN', groups: [], forms: ['tablet'], strengths: ['10 mg', '20 mg', '40 mg'] },
  { code: 'SIMVASTATIN', generic: 'Simvastatin', brands: ['Simvotin'], drugClass: 'STATIN', groups: [], forms: ['tablet'], strengths: ['10 mg', '20 mg'] },
  { code: 'CLOPIDOGREL', generic: 'Clopidogrel', brands: ['Clopilet', 'Plavix'], drugClass: 'ANTIPLATELET', groups: [], forms: ['tablet'], strengths: ['75 mg'] },
  { code: 'WARFARIN', generic: 'Warfarin', brands: ['Warf'], drugClass: 'ANTICOAGULANT', groups: [], forms: ['tablet'], strengths: ['1 mg', '2 mg', '5 mg'] },
  { code: 'DIGOXIN', generic: 'Digoxin', brands: ['Lanoxin'], drugClass: 'CARDIAC_GLYCOSIDE', groups: [], forms: ['tablet'], strengths: ['0.25 mg'] },
  { code: 'AMIODARONE', generic: 'Amiodarone', brands: ['Cordarone'], drugClass: 'ANTIARRHYTHMIC', groups: [], forms: ['tablet'], strengths: ['100 mg', '200 mg'] },
  { code: 'ISOSORBIDE_MN', generic: 'Isosorbide mononitrate', brands: ['Monotrate'], drugClass: 'NITRATE', groups: [], forms: ['tablet'], strengths: ['20 mg', '30 mg'] },
  { code: 'SILDENAFIL', generic: 'Sildenafil', brands: ['Viagra', 'Penegra'], drugClass: 'PDE5_INHIBITOR', groups: [], forms: ['tablet'], strengths: ['25 mg', '50 mg'] },
  { code: 'OMEPRAZOLE', generic: 'Omeprazole', brands: ['Omez'], drugClass: 'PPI', groups: [], forms: ['capsule'], strengths: ['20 mg'] },
  { code: 'PANTOPRAZOLE', generic: 'Pantoprazole', brands: ['Pan', 'Pantocid'], drugClass: 'PPI', groups: [], forms: ['tablet'], strengths: ['40 mg'] },
  { code: 'ONDANSETRON', generic: 'Ondansetron', brands: ['Emeset'], drugClass: 'ANTIEMETIC', groups: [], forms: ['tablet', 'syrup'], strengths: ['4 mg', '8 mg'] },
  { code: 'CETIRIZINE', generic: 'Cetirizine', brands: ['Cetzine', 'Okacet'], drugClass: 'ANTIHISTAMINE', groups: [], forms: ['tablet', 'syrup'], strengths: ['10 mg'] },
  { code: 'MONTELUKAST', generic: 'Montelukast', brands: ['Montair'], drugClass: 'LTRA', groups: [], forms: ['tablet'], strengths: ['10 mg'] },
  { code: 'SALBUTAMOL', generic: 'Salbutamol', brands: ['Asthalin'], drugClass: 'BETA_AGONIST', groups: [], forms: ['inhaler', 'tablet'], strengths: ['100 mcg', '2 mg'] },
  { code: 'THEOPHYLLINE', generic: 'Theophylline', brands: ['Deriphyllin'], drugClass: 'METHYLXANTHINE', groups: [], forms: ['tablet'], strengths: ['150 mg'] },
  { code: 'LEVOTHYROXINE', generic: 'Levothyroxine', brands: ['Thyronorm', 'Eltroxin'], drugClass: 'THYROID', groups: [], forms: ['tablet'], strengths: ['25 mcg', '50 mcg', '100 mcg'] },
  { code: 'SERTRALINE', generic: 'Sertraline', brands: ['Serta'], drugClass: 'SSRI', groups: [], forms: ['tablet'], strengths: ['50 mg'] },
  { code: 'ESCITALOPRAM', generic: 'Escitalopram', brands: ['Nexito'], drugClass: 'SSRI', groups: [], forms: ['tablet'], strengths: ['10 mg'] },
  { code: 'METHOTREXATE', generic: 'Methotrexate', brands: ['Folitrax'], drugClass: 'ANTIMETABOLITE', groups: [], forms: ['tablet'], strengths: ['2.5 mg', '7.5 mg'] },
  { code: 'PREDNISOLONE', generic: 'Prednisolone', brands: ['Wysolone'], drugClass: 'CORTICOSTEROID', groups: [], forms: ['tablet'], strengths: ['5 mg', '10 mg'] },
];

/** Words patients and staff use for an allergy → the groups it covers. */
export const ALLERGY_WORDS: [RegExp, AllergyGroup[]][] = [
  [/penicillin|amoxi|augmentin|ampicillin|cloxacillin/i, ['PENICILLIN']],
  [/cephalosporin|cef|cephalexin|ceph/i, ['CEPHALOSPORIN']],
  [/sulf|sulph|septran|bactrim|cotrimoxazole/i, ['SULFONAMIDE']],
  [/nsaid|aspirin|ibuprofen|brufen|diclofenac|voveran|naproxen|painkiller/i, ['NSAID']],
  [/macrolide|azithro|clarithro|erythro/i, ['MACROLIDE']],
  [/quinolone|floxacin|ciplox/i, ['FLUOROQUINOLONE']],
  [/codeine|morphine|tramadol|opioid|opiate/i, ['OPIOID']],
  [/tetracycline|doxy/i, ['TETRACYCLINE']],
];

/** Groups that are not the same drug family but can cross-react (a caution, not a block). */
export const CROSS_REACTIVE: [AllergyGroup, AllergyGroup][] = [['PENICILLIN', 'CEPHALOSPORIN']];

export type Severity = 'MAJOR' | 'MODERATE';
/** An interaction between two drugs, by generic code or by class (either side). */
export interface Interaction { a: string[]; b: string[]; severity: Severity; effect: string }

const NSAIDS = ['NSAID'];
export const INTERACTIONS: Interaction[] = [
  { a: ['WARFARIN'], b: NSAIDS, severity: 'MAJOR', effect: 'bleeding risk rises sharply' },
  { a: ['WARFARIN'], b: ['CLARITHROMYCIN', 'METRONIDAZOLE', 'FLUCONAZOLE', 'CIPROFLOXACIN', 'COTRIMOXAZOLE', 'AMIODARONE'], severity: 'MAJOR', effect: 'INR rises (bleeding risk): avoid, or check INR closely' },
  { a: ['CLOPIDOGREL'], b: ['OMEPRAZOLE'], severity: 'MODERATE', effect: 'omeprazole weakens clopidogrel: prefer pantoprazole' },
  { a: ['CLOPIDOGREL', 'WARFARIN'], b: ['ASPIRIN'], severity: 'MODERATE', effect: 'more bleeding risk: only if both are intended' },
  { a: ['SIMVASTATIN'], b: ['CLARITHROMYCIN', 'FLUCONAZOLE'], severity: 'MAJOR', effect: 'statin levels rise: risk of muscle breakdown (rhabdomyolysis)' },
  { a: ['ATORVASTATIN'], b: ['CLARITHROMYCIN'], severity: 'MODERATE', effect: 'statin levels rise: watch for muscle pain' },
  { a: ['ACE_INHIBITOR', 'ARB'], b: ['SPIRONOLACTONE'], severity: 'MAJOR', effect: 'high potassium (hyperkalaemia): check potassium and kidney function' },
  { a: ['ACE_INHIBITOR', 'ARB'], b: NSAIDS, severity: 'MODERATE', effect: 'kidney function may worsen and blood pressure control weakens' },
  { a: ['SSRI'], b: ['TRAMADOL'], severity: 'MAJOR', effect: 'serotonin syndrome and seizure risk' },
  { a: ['SSRI'], b: NSAIDS, severity: 'MODERATE', effect: 'more bleeding risk (stomach)' },
  { a: ['METHOTREXATE'], b: ['COTRIMOXAZOLE'], severity: 'MAJOR', effect: 'methotrexate toxicity (bone marrow suppression)' },
  { a: ['METHOTREXATE'], b: NSAIDS, severity: 'MODERATE', effect: 'methotrexate levels rise' },
  { a: ['SILDENAFIL'], b: ['NITRATE'], severity: 'MAJOR', effect: 'severe low blood pressure: never together' },
  { a: ['DIGOXIN'], b: ['AMIODARONE', 'CLARITHROMYCIN'], severity: 'MAJOR', effect: 'digoxin levels rise (toxicity): halve the dose and check levels' },
  { a: ['THEOPHYLLINE'], b: ['CIPROFLOXACIN', 'CLARITHROMYCIN'], severity: 'MAJOR', effect: 'theophylline toxicity (seizures, arrhythmia)' },
  { a: ['GLIMEPIRIDE'], b: ['FLUCONAZOLE', 'COTRIMOXAZOLE'], severity: 'MODERATE', effect: 'low blood sugar risk' },
  { a: ['LEVOFLOXACIN', 'CIPROFLOXACIN'], b: ['PREDNISOLONE'], severity: 'MODERATE', effect: 'tendon rupture risk, especially over 60' },
];
