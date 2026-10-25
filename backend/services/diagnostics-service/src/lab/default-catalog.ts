/**
 * Template lab catalog copied into every hospital (they edit prices and switch tests off afterwards). Reference ranges
 * are typical adult ranges used for HIGH/LOW flags in Phase 15; each lab replaces them with its own validated ranges.
 */
export interface RefRange { param: string; unit: string; low?: number; high?: number; sex?: 'M' | 'F'; criticalLow?: number; criticalHigh?: number }
export interface TemplateTest {
  code: string; name: string; aliases?: string[]; category: string; sampleType: 'BLOOD' | 'URINE' | 'STOOL' | 'SWAB' | 'NONE'; container?: string;
  preparation?: string; fastingHours?: number; turnaroundHours: number; price: number; loinc?: string; ranges: RefRange[];
}

const EDTA = 'EDTA (lavender cap)';
const SERUM = 'Serum (yellow cap)';
const FLUORIDE = 'Fluoride (grey cap)';

export const DEFAULT_TESTS: TemplateTest[] = [
  { code: 'CBC', name: 'Complete Blood Count', aliases: ['blood count', 'hemogram', 'cbc'], category: 'Haematology', sampleType: 'BLOOD', container: EDTA, turnaroundHours: 6, price: 350, loinc: '58410-2',
    ranges: [{ param: 'Haemoglobin', unit: 'g/dL', low: 13, high: 17, sex: 'M', criticalLow: 7 }, { param: 'Haemoglobin', unit: 'g/dL', low: 12, high: 15, sex: 'F', criticalLow: 7 },
      { param: 'WBC count', unit: '10³/µL', low: 4, high: 11, criticalHigh: 30 }, { param: 'Platelet count', unit: '10³/µL', low: 150, high: 410, criticalLow: 20 }] },
  { code: 'ESR', name: 'Erythrocyte Sedimentation Rate', aliases: ['esr'], category: 'Haematology', sampleType: 'BLOOD', container: EDTA, turnaroundHours: 6, price: 150, ranges: [{ param: 'ESR', unit: 'mm/hr', low: 0, high: 20 }] },
  { code: 'FBS', name: 'Fasting Blood Sugar', aliases: ['sugar test', 'fasting glucose', 'fbs'], category: 'Biochemistry', sampleType: 'BLOOD', container: FLUORIDE,
    preparation: 'Fast for 8–10 hours (water is fine)', fastingHours: 8, turnaroundHours: 4, price: 120, loinc: '1558-6',
    ranges: [{ param: 'Glucose, fasting', unit: 'mg/dL', low: 70, high: 99, criticalLow: 40, criticalHigh: 400 }] },
  { code: 'HBA1C', name: 'HbA1c (Glycated Haemoglobin)', aliases: ['sugar test', 'a1c', 'hba1c', 'diabetes'], category: 'Biochemistry', sampleType: 'BLOOD', container: EDTA, turnaroundHours: 12, price: 550, loinc: '4548-4',
    ranges: [{ param: 'HbA1c', unit: '%', low: 4, high: 5.6 }] },
  { code: 'LIPID', name: 'Lipid Profile', aliases: ['cholesterol', 'lipid'], category: 'Biochemistry', sampleType: 'BLOOD', container: SERUM, preparation: 'Fast for 10–12 hours (water is fine)', fastingHours: 10, turnaroundHours: 12, price: 600,
    ranges: [{ param: 'Total cholesterol', unit: 'mg/dL', high: 200 }, { param: 'Triglycerides', unit: 'mg/dL', high: 150 }, { param: 'HDL cholesterol', unit: 'mg/dL', low: 40 }, { param: 'LDL cholesterol', unit: 'mg/dL', high: 100 }] },
  { code: 'LFT', name: 'Liver Function Test', aliases: ['liver', 'lft'], category: 'Biochemistry', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 12, price: 700,
    ranges: [{ param: 'Bilirubin, total', unit: 'mg/dL', low: 0.3, high: 1.2 }, { param: 'ALT (SGPT)', unit: 'U/L', low: 7, high: 56 }, { param: 'AST (SGOT)', unit: 'U/L', low: 10, high: 40 }, { param: 'Alkaline phosphatase', unit: 'U/L', low: 44, high: 147 }, { param: 'Albumin', unit: 'g/dL', low: 3.5, high: 5 }] },
  { code: 'KFT', name: 'Kidney Function Test', aliases: ['kidney', 'rft', 'creatinine', 'kft'], category: 'Biochemistry', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 12, price: 650,
    ranges: [{ param: 'Urea', unit: 'mg/dL', low: 15, high: 40 }, { param: 'Creatinine', unit: 'mg/dL', low: 0.7, high: 1.3, sex: 'M', criticalHigh: 6 }, { param: 'Creatinine', unit: 'mg/dL', low: 0.6, high: 1.1, sex: 'F', criticalHigh: 6 }, { param: 'Uric acid', unit: 'mg/dL', low: 3.5, high: 7.2 }] },
  { code: 'ELECTROLYTES', name: 'Serum Electrolytes', aliases: ['sodium', 'potassium'], category: 'Biochemistry', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 6, price: 500,
    ranges: [{ param: 'Sodium', unit: 'mmol/L', low: 135, high: 145, criticalLow: 120, criticalHigh: 160 }, { param: 'Potassium', unit: 'mmol/L', low: 3.5, high: 5.1, criticalLow: 2.5, criticalHigh: 6.5 }, { param: 'Chloride', unit: 'mmol/L', low: 98, high: 107 }] },
  { code: 'CALCIUM', name: 'Serum Calcium', category: 'Biochemistry', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 12, price: 250, ranges: [{ param: 'Calcium', unit: 'mg/dL', low: 8.5, high: 10.5, criticalLow: 6.5, criticalHigh: 13 }] },
  { code: 'TSH', name: 'TSH (Thyroid Stimulating Hormone)', aliases: ['thyroid', 'tsh'], category: 'Immunoassay', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 24, price: 400, ranges: [{ param: 'TSH', unit: 'mIU/L', low: 0.4, high: 4 }] },
  { code: 'T3', name: 'Total T3', aliases: ['thyroid'], category: 'Immunoassay', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 24, price: 250, ranges: [{ param: 'Total T3', unit: 'ng/dL', low: 80, high: 200 }] },
  { code: 'T4', name: 'Total T4', aliases: ['thyroid'], category: 'Immunoassay', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 24, price: 250, ranges: [{ param: 'Total T4', unit: 'µg/dL', low: 5, high: 12 }] },
  { code: 'VITD', name: 'Vitamin D (25-OH)', aliases: ['vitamin d'], category: 'Immunoassay', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 48, price: 1400, ranges: [{ param: '25-OH Vitamin D', unit: 'ng/mL', low: 30, high: 100 }] },
  { code: 'VITB12', name: 'Vitamin B12', aliases: ['b12'], category: 'Immunoassay', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 48, price: 900, ranges: [{ param: 'Vitamin B12', unit: 'pg/mL', low: 211, high: 911 }] },
  { code: 'CRP', name: 'C-Reactive Protein', aliases: ['crp', 'inflammation'], category: 'Immunology', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 6, price: 450, ranges: [{ param: 'CRP', unit: 'mg/L', low: 0, high: 5 }] },
  { code: 'PSA', name: 'PSA (Prostate Specific Antigen)', category: 'Immunoassay', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 24, price: 800, ranges: [{ param: 'PSA, total', unit: 'ng/mL', low: 0, high: 4 }] },
  { code: 'DENGUE_NS1', name: 'Dengue NS1 Antigen', aliases: ['dengue'], category: 'Serology', sampleType: 'BLOOD', container: SERUM, turnaroundHours: 6, price: 600, ranges: [] },
  { code: 'MALARIA_AG', name: 'Malaria Antigen (rapid)', aliases: ['malaria'], category: 'Serology', sampleType: 'BLOOD', container: EDTA, turnaroundHours: 4, price: 350, ranges: [] },
  { code: 'URINE_RE', name: 'Urine Routine & Microscopy', aliases: ['urine test', 'urine'], category: 'Clinical pathology', sampleType: 'URINE', container: 'Sterile urine container',
    preparation: 'First morning sample preferred; collect midstream', turnaroundHours: 6, price: 150, ranges: [{ param: 'pH', unit: '', low: 4.5, high: 8 }, { param: 'Specific gravity', unit: '', low: 1.005, high: 1.03 }] },
  { code: 'URINE_CULTURE', name: 'Urine Culture & Sensitivity', category: 'Microbiology', sampleType: 'URINE', container: 'Sterile urine container', preparation: 'Collect before starting antibiotics', turnaroundHours: 72, price: 700, ranges: [] },
  { code: 'STOOL_RE', name: 'Stool Routine', category: 'Clinical pathology', sampleType: 'STOOL', container: 'Stool container', turnaroundHours: 12, price: 200, ranges: [] },
  { code: 'THROAT_SWAB', name: 'Throat Swab Culture', category: 'Microbiology', sampleType: 'SWAB', container: 'Swab with transport medium', turnaroundHours: 72, price: 650, ranges: [] },
  { code: 'XRAY_CHEST', name: 'X-ray Chest (PA view)', aliases: ['x-ray', 'xray'], category: 'Radiology', sampleType: 'NONE', preparation: 'Remove metal objects; inform staff if pregnant', turnaroundHours: 4, price: 400, ranges: [] },
];

export const DEFAULT_PACKAGES: { code: string; name: string; description: string; price: number; tests: string[] }[] = [
  { code: 'FULL_BODY', name: 'Full Body Checkup', description: 'Blood count, sugar, cholesterol, liver, kidney, thyroid, vitamins and urine: a yearly check for adults', price: 2999,
    tests: ['CBC', 'FBS', 'HBA1C', 'LIPID', 'LFT', 'KFT', 'TSH', 'VITD', 'VITB12', 'URINE_RE'] },
  { code: 'DIABETES', name: 'Diabetes Screening', description: 'Fasting sugar, HbA1c, kidney function and urine', price: 999, tests: ['FBS', 'HBA1C', 'KFT', 'URINE_RE'] },
  { code: 'HEART', name: 'Heart Health', description: 'Cholesterol, sugar, inflammation and electrolytes', price: 1299, tests: ['LIPID', 'FBS', 'CRP', 'ELECTROLYTES'] },
  { code: 'THYROID', name: 'Thyroid Profile', description: 'T3, T4 and TSH', price: 599, tests: ['T3', 'T4', 'TSH'] },
  { code: 'FEVER', name: 'Fever Panel', description: 'For fever of more than 3 days: blood count, ESR, CRP, dengue, malaria and urine', price: 1499, tests: ['CBC', 'ESR', 'CRP', 'DENGUE_NS1', 'MALARIA_AG', 'URINE_RE'] },
];

/** Default lab collection hours for a branch: Mon–Sat 07:00–12:00, Sun 08:00–10:00, 15-minute slots, 3 patients each. */
export const DEFAULT_WINDOWS = [1, 2, 3, 4, 5, 6].map((d) => ({ day: d, start: '07:00', end: '12:00' })).concat([{ day: 7, start: '08:00', end: '10:00' }]);
/** Home collection: early mornings (most tests are fasting), 30-minute visits, 2 phlebotomists' worth of visits per time. */
export const DEFAULT_HOME_WINDOWS = [1, 2, 3, 4, 5, 6].map((d) => ({ day: d, start: '06:30', end: '10:30' })).concat([{ day: 7, start: '07:00', end: '09:00' }]);
