/**
 * Output policy (docs/AI-AGENTS.md §4.3, §10): every model answer is checked in code before a patient sees it. The
 * assistant must not prescribe (medicines, doses), diagnose, or reveal its instructions. A violation replaces the whole
 * answer with a safe one; only the rule ids are kept (never the text) for review.
 *
 * Kept narrow on purpose: test preparation legitimately says "drink 500 ml of water" or "fast for 10 hours", so a
 * quantity alone is not a dose; a quantity next to a medicine word, or a medicine unit (mg, tablets…), is.
 */
const MEDS = String.raw`(?:paracetamol|acetaminophen|ibuprofen|aspirin|diclofenac|nimesulide|crocin|dolo|calpol|combiflam|disprin|antibiotics?|amoxicillin|augmentin|azithromycin|ciprofloxacin|cetirizine|levocetirizine|montelukast|metformin|glimepiride|insulin|atorvastatin|amlodipine|losartan|telmisartan|pantoprazole|omeprazole|ranitidine|ondansetron|domperidone|prednisolone|dexamethasone|steroids?|painkillers?|sleeping pills?|antidepressants?|tablets?|capsules?|syrup|medicines?|medications?|drugs?|दवा|दवाई|गोली)`;

interface PolicyRule { id: string; re: RegExp }
const RULES: PolicyRule[] = [
  // "500 mg", "2 tablets", "10 units of insulin"
  { id: 'DOSE_UNIT', re: /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|milligrams?|micrograms?|iu|units?\b(?=[^.]{0,20}insulin)|tablets?|tabs|capsules?|caps|puffs?|sachets?)\b/i },
  // "take paracetamol", "start an antibiotic", "you should use crocin"
  // (not "collect before starting antibiotics": a timing, not advice)
  { id: 'MEDICINE_ADVICE', re: new RegExp(String.raw`(?<!\b(?:before|after|until|without|while)\s)\b(?:take|taking|start|starting|use|using|try|give|increase|reduce|stop|double)\b[^.?!\n]{0,40}\b${MEDS}`, 'i') },
  { id: 'MEDICINE_ADVICE', re: new RegExp(String.raw`${MEDS}[^.?!\n]{0,30}\b(?:twice|thrice|once|every \d+ hours?|daily|a day|at night|after food|before food)\b`, 'i') },
  { id: 'MEDICINE_ADVICE', re: /(?:दवा|दवाई|गोली)[^।.?!\n]{0,30}(?:लें|लीजिए|खाएं|खाइए)/ },
  // "you have diabetes", "it is likely an infection", "this sounds like a heart attack"
  { id: 'DIAGNOSIS', re: /(?<!\b(?:if|when|whether|unless|in case)\s)\byou(?:'ve| have| might have| may have| probably have| likely have| definitely have| seem to have| are suffering from| suffer from)\b[^.?!\n]{0,40}\b(?:infection|disease|diabetes|cancer|tumou?r|heart attack|syndrome|disorder|failure|deficiency|hypertension|asthma|covid|dengue|malaria|typhoid|tuberculosis|tb|pneumonia|fracture|stroke|depression|anxiety|\w+itis)\b/i },
  { id: 'DIAGNOSIS', re: /\b(?:it|this) (?:is|sounds|looks|seems) (?:like |most likely |probably |definitely |clearly )*(?:an? )?(?:infection|heart attack|stroke|cancer|dengue|malaria|typhoid|covid|pneumonia|fracture|migraine|\w+itis)\b/i },
  { id: 'DIAGNOSIS', re: /\b(?:my|the) diagnosis is\b|\bi diagnose\b/i },
  // instructions leaking
  { id: 'PROMPT_LEAK', re: /\b(?:my|the) (?:system prompt|system instructions?|instructions are)\b|hospital_information>/i },
];

export interface PolicyResult { ok: boolean; rules: string[] }

export function checkOutput(text: string): PolicyResult {
  const rules = [...new Set(RULES.filter((r) => r.re.test(text)).map((r) => r.id))];
  return { ok: rules.length === 0, rules };
}

export const blockedReply = (language: string) => language === 'hi'
  ? 'मैं दवाइयों, खुराक या बीमारी के बारे में सलाह नहीं दे सकता। कृपया डॉक्टर से मिलें, या "किसी व्यक्ति से बात करें" दबाएँ।'
  : 'I can\'t advise on medicines, doses or what an illness might be. Please see a doctor, or tap "Talk to a person" and our team will call you.';
