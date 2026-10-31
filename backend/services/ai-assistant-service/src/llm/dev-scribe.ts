import { parseSoapTurn, type SoapNote } from '../scribe/soap.js';

/**
 * The dev provider's SOAP writer: reads a "Doctor:/Patient:" transcript with simple patterns, so the scribe flow
 * (draft → checks → the doctor's edits → sign) runs without calling Google. It understands the phrasing of the mock
 * consultations in the tests; Gemini does the real work.
 */
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30 };
const n = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s.toLowerCase()] ?? 0);
const ICD: [RegExp, string][] = [[/tonsillitis/i, 'J03.9'], [/pharyngitis|sore throat/i, 'J02.9'], [/upper respiratory|common cold|urti/i, 'J06.9'], [/hypertension|high blood pressure/i, 'I10'], [/type 2 diabetes|diabetes/i, 'E11.9'], [/gastritis/i, 'K29.7'], [/migraine/i, 'G43.9']];
const DOSAGE: [RegExp, string][] = [[/three times a day|thrice daily|tds/i, '1-1-1'], [/twice a day|two times a day|bd/i, '1-0-1'], [/at night|bedtime/i, '0-0-1'], [/once a day|daily|od/i, '1-0-0'], [/when needed|if needed|as needed|sos/i, 'SOS']];

export function devSoap(turn: string): SoapNote {
  const lines = parseSoapTurn(turn).split('\n').map((l) => l.trim()).filter(Boolean);
  const said = (who: string) => lines.filter((l) => l.toLowerCase().startsWith(`${who}:`)).map((l) => l.slice(who.length + 1).trim());
  const doctor = said('doctor');
  const patient = said('patient');
  const all = doctor.join(' ');
  const sentences = doctor.flatMap((l) => l.split(/(?<=\.)\s+/));

  const bp = /\b(\d{2,3}\/\d{2,3})\b/.exec(all)?.[1];
  const pulse = /pulse (?:is )?(\d{2,3})/i.exec(all)?.[1];
  const temp = /temperature (?:is )?(\d{2}(?:\.\d)?)/i.exec(all)?.[1];
  const spo2 = /(?:spo2|oxygen|saturation) (?:is )?(\d{2,3})/i.exec(all)?.[1];
  const exam = sentences.filter((s) => /throat|chest|lungs|abdomen|tonsil|examin|tender|swollen|clear|red\b/i.test(s)).map((s) => s.replace(/^.*?\d+\/\d+\.?\s*/, '')).join(' ');

  const dx = /(?:looks like|diagnosis is|this is|you have) ([a-z0-9 -]+?)(?:\.|,|$)/i.exec(all)?.[1]?.trim();
  const assessment = dx ? [{ description: dx[0].toUpperCase() + dx.slice(1), ...(ICD.find(([re]) => re.test(dx)) ? { icd10Suggestion: ICD.find(([re]) => re.test(dx))![1] } : {}), confidence: 'HIGH' as const }] : [];

  const medications: SoapNote['plan']['medications'] = [];
  const uncertainties: string[] = [];
  for (const s of sentences.filter((x) => /\b(start|give|prescribe|continue|take)\b/i.test(x))) {
    for (const clause of s.split(/,\s*and\s+|;\s*|\band\b(?=\s+[a-z]+\s+\d)/i)) {
      const m = /(?:start|give|prescribe|continue|take|and)?\s*([A-Za-z][A-Za-z+ -]*?)\s+(\d+(?:\.\d+)?\s?(?:mg|mcg|ml|g))\b(.*)/i.exec(clause.replace(/^.*?\b(start|give|prescribe|continue|take)\b\s*/i, ''));
      if (!m) continue;
      const rest = m[3];
      const days = /for (\d+|[a-z]+) days?/i.exec(rest)?.[1];
      const dosage = DOSAGE.find(([re]) => re.test(rest))?.[1] ?? '';
      if (!days) uncertainties.push(`${m[1].trim()}: no duration was said`);
      if (!dosage) uncertainties.push(`${m[1].trim()}: no dosage was said`);
      medications.push({ drug: m[1].trim().replace(/^(a|an|the)\s+/i, ''), strength: m[2].replace(/\s+/, ' '), dosage, durationDays: days ? n(days) : 0, instructions: /when needed|if needed|sos/i.test(rest) ? `when needed${/fever/i.test(rest) ? ' for fever' : ''}` : /after food/i.test(rest) ? 'after food' : '' });
    }
  }
  const labTests = [...all.matchAll(/(?:do|order|check|get) (?:a |an |your )?([A-Za-z0-9]{2,8})(?: test)?\b/gi)].map((m) => m[1].toUpperCase()).filter((c) => /^(CBC|HBA1C|TSH|FBS|LFT|KFT|ESR|CRP|LIPID|URINE)$/.test(c)).map((testCode) => ({ testCode, reason: dx ?? '' }));
  const advice = sentences.filter((s) => /drink|rest|avoid|walk|diet|fluids|salt/i.test(s)).join(' ');
  const follow = /come back in (\d+|[a-z]+) days?/i.exec(all)?.[1];
  return {
    subjective: patient.join(' '),
    objective: { vitals: { ...(bp ? { bp } : {}), ...(pulse ? { pulse: Number(pulse) } : {}), ...(temp ? { tempC: Number(temp) } : {}), ...(spo2 ? { spo2: Number(spo2) } : {}) }, examination: exam },
    assessment,
    plan: { medications, labTests, advice, ...(follow ? { followUpInDays: n(follow) } : {}) },
    uncertainties,
  };
}
