import { createHash } from 'node:crypto';

/**
 * Search-time synonyms (docs/IMPLEMENTATION-PLAN.md Phase 21). Patients type symptoms or everyday words; these map
 * them to the words used in specialty and test names. "a, b => c" replaces a or b by c in the query only (the indexed
 * text is not expanded), so "chest pain" finds Cardiology without making every "pain" match.
 * Change these freely: the index version below changes with them and the indexes are rebuilt on the next start.
 */
export const DOCTOR_SYNONYMS = [
  'chest pain, heart pain, palpitation, palpitations, heart attack, heart problem, angina => cardiology',
  'high blood pressure, hypertension, bp => cardiology, general medicine',
  'skin rash, rash, acne, pimples, eczema, psoriasis, itching, hair fall, hair loss, dandruff => dermatology',
  'child, children, baby, babies, infant, kid, kids, newborn, vaccination => pediatrics',
  'joint pain, knee pain, back pain, neck pain, fracture, sprain, arthritis, bone => orthopedics',
  'pregnancy, pregnant, periods, menstrual, pcos, pcod, fertility => gynecology',
  'ear pain, earache, sore throat, sinus, sinusitis, tonsils, hearing loss, nose bleed => ent',
  'eye, eyes, vision, blurred vision, spectacles, cataract, red eye => ophthalmology',
  'headache, migraine, seizure, seizures, fits, epilepsy, numbness, stroke, dizziness => neurology',
  'anxiety, depression, stress, insomnia, sleep problem, mental health, panic => psychiatry',
  'tooth, teeth, toothache, gums, cavity, root canal, braces => dentistry',
  'stomach pain, acidity, gas, constipation, diarrhoea, diarrhea, vomiting, liver, jaundice => gastroenterology',
  'cough, asthma, breathlessness, breathing problem, wheezing, lungs, tb, tuberculosis => pulmonology',
  'diabetes, sugar, thyroid, hormones, hormone, obesity => endocrinology',
  'kidney stone, urine infection, uti, prostate, burning urine => urology',
  'fever, cold, flu, infection, body ache, weakness, general physician, gp => general medicine',
  // what the doctors are called
  'cardiologist, heart specialist, heart doctor => cardiology',
  'dermatologist, skin specialist, skin doctor => dermatology',
  'pediatrician, paediatrician, child specialist, child doctor => pediatrics',
  'orthopedic, orthopaedic, orthopedician, bone doctor => orthopedics',
  'gynecologist, gynaecologist, obstetrician, gynaecology => gynecology',
  'ent specialist, ear doctor => ent',
  'ophthalmologist, eye doctor, eye specialist => ophthalmology',
  'neurologist, brain doctor => neurology',
  'psychiatrist => psychiatry',
  'dentist, dental => dentistry',
  'gastroenterologist, stomach doctor => gastroenterology',
  'pulmonologist, chest specialist, lung doctor => pulmonology',
  'endocrinologist, diabetologist => endocrinology',
  'urologist => urology',
  'physician, family doctor => general medicine',
];

export const TEST_SYNONYMS = [
  'sugar test, blood sugar, diabetes test, glucose test, diabetes => hba1c, sugar, diabetes',
  'thyroid test, thyroid => tsh, thyroid, t3, t4',
  'cholesterol, cholesterol test, heart test, heart checkup => lipid, heart',
  'blood test, blood count, hemoglobin, haemoglobin => complete blood count, cbc',
  'kidney test, creatinine, urea => kidney, kft',
  'liver test, sgpt, sgot => liver, lft',
  'urine test => urine',
  'vitamin test, vitamins => vitamin',
  'full checkup, health checkup, master checkup, full body => full body, checkup',
  'fever test, dengue test, malaria test => fever, dengue, malaria',
];

function analysis(synonyms: string[]) {
  return {
    filter: { mc_synonyms: { type: 'synonym_graph', synonyms, lenient: true } },
    analyzer: {
      mc_text: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'asciifolding'] },
      mc_search: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'mc_synonyms'] },
    },
  };
}
const text = { type: 'text', analyzer: 'mc_text', search_analyzer: 'mc_search' };

export const DOCTOR_INDEX = {
  settings: { index: { number_of_shards: 1, number_of_replicas: 0 }, analysis: analysis(DOCTOR_SYNONYMS) },
  mappings: {
    properties: {
      id: { type: 'keyword' },
      name: { ...text, fields: { raw: { type: 'keyword' } } },
      specialties: text,
      keywords: text,
      specialtyCodes: { type: 'keyword' }, branchIds: { type: 'keyword' }, languages: { type: 'keyword' }, gender: { type: 'keyword' }, modes: { type: 'keyword' },
      nextAvailableAt: { type: 'date' },
      // for sorting and paging: nextAvailableAt, or far in the future when there is no open slot (a "missing" sort
      // value would be Long.MAX, which does not survive JSON in the paging cursor)
      nextSort: { type: 'date' },
      profile: { type: 'object', enabled: false },
    },
  },
};

export const TEST_INDEX = {
  settings: { index: { number_of_shards: 1, number_of_replicas: 0 }, analysis: analysis(TEST_SYNONYMS) },
  mappings: {
    properties: {
      name: { ...text, fields: { raw: { type: 'keyword' } } },
      aliases: text, category: text, contains: text,
      id: { type: 'keyword' }, code: { type: 'keyword' }, kind: { type: 'keyword' }, price: { type: 'float' },
      item: { type: 'object', enabled: false },
    },
  },
};

/** Changes whenever the index definitions (synonyms included) change: an outdated index is rebuilt. */
export const INDEX_VERSION = createHash('sha256').update(JSON.stringify([DOCTOR_INDEX, TEST_INDEX])).digest('hex').slice(0, 12);
