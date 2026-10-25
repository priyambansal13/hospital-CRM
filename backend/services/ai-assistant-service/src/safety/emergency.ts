/**
 * Layer 1 of symptom safety (docs/AI-AGENTS.md §4.3): deterministic emergency rules that run BEFORE the model, in
 * code, so no conversation can talk its way past them. Tuned for recall: a false alarm shows emergency numbers to
 * someone who did not need them; a miss can cost a life. English, Hindi (Devanagari) and Hinglish (Hindi in Latin
 * letters) first; typos of longer words are forgiven (one edit).
 *
 * A rule matches when every one of its groups matches; a group matches when any of its terms does. Latin-script
 * terms match whole words (multi-word terms: consecutive words); Devanagari terms match anywhere (Hindi joins
 * postpositions and endings to words).
 */
export type EmergencyCategory = 'CARDIAC' | 'BREATHING' | 'STROKE' | 'BLEEDING' | 'PREGNANCY' | 'SELF_HARM' | 'UNCONSCIOUS' | 'POISONING' | 'ALLERGY' | 'INJURY';

interface Rule { category: EmergencyCategory; all: string[][] }

const CHEST = ['chest', 'heart', 'seene', 'seena', 'sine', 'seeney', 'chhati', 'chati', 'सीने', 'सीना', 'छाती', 'दिल'];
const PAINISH = ['pain', 'ache', 'aching', 'hurts', 'hurting', 'tight', 'tightness', 'pressure', 'heavy', 'heaviness', 'squeezing', 'crushing', 'burning', 'dard', 'jakdan', 'bhari', 'bhaari', 'दर्द', 'जकड़', 'जकड', 'भारी', 'दबाव'];
const ACUTE = ['now', 'right now', 'sudden', 'suddenly', 'severe', 'crushing', 'unbearable', 'worst', 'very bad', 'spreading', 'left arm', 'arm', 'jaw', 'sweating', 'sweaty', 'sweat', 'breathless', 'cant breathe', 'at rest', 'since an hour', 'for an hour', 'abhi', 'achanak', 'tez', 'bahut', 'pasina', 'paseena', 'अभी', 'अचानक', 'तेज', 'बहुत', 'पसीना', 'बाँह', 'बांह', 'जबड़'];

const RULES: Rule[] = [
  // heart
  { category: 'CARDIAC', all: [CHEST, PAINISH, ACUTE] },
  { category: 'CARDIAC', all: [['heart attack', 'cardiac arrest', 'heart stopped', 'dil ka daura', 'heart atak', 'हार्ट अटैक', 'दिल का दौरा', 'दिल का दौर']] },
  // breathing
  { category: 'BREATHING', all: [['cant breathe', 'cant breath', 'struggling to breathe', 'difficulty breathing', 'trouble breathing', 'gasping', 'choking', 'not breathing', 'stopped breathing', 'blue lips', 'lips turning blue', 'lips are blue', 'saans nahi', 'sans nahi', 'saans nahin', 'saans ruk', 'sans ruk', 'saans phool', 'सांस नहीं', 'साँस नहीं', 'सांस रुक', 'साँस रुक', 'सांस फूल', 'साँस फूल', 'दम घुट']] },
  // stroke (FAST)
  { category: 'STROKE', all: [['stroke', 'face drooping', 'face droop', 'face is drooping', 'drooping face', 'slurred speech', 'speech is slurred', 'speech slurred', 'slurring', 'cant speak', 'cant talk', 'lakwa', 'lakva', 'paralysis', 'paralysed', 'paralyzed', 'लकवा', 'मुंह टेढ़ा', 'मुँह टेढ़ा', 'चेहरा टेढ़ा', 'बोल नहीं पा']] },
  { category: 'STROKE', all: [['one side', 'left side', 'right side', 'half body', 'ek taraf', 'एक तरफ'], ['weak', 'weakness', 'numb', 'numbness', 'cant move', 'kamzori', 'sunn', 'कमजोरी', 'सुन्न']] },
  // bleeding
  { category: 'BLEEDING', all: [['bleeding heavily', 'heavy bleeding', 'severe bleeding', 'bleeding a lot', 'lot of blood', 'lots of blood', 'wont stop bleeding', 'bleeding wont stop', 'bleeding not stopping', 'not stop bleeding', 'blood everywhere', 'vomiting blood', 'coughing blood', 'coughing up blood', 'blood in vomit', 'khoon nahi ruk', 'khoon nahin ruk', 'bahut khoon', 'khoon ki ulti', 'खून नहीं रुक', 'बहुत खून', 'खून की उल्टी', 'खून बह']] },
  { category: 'PREGNANCY', all: [['pregnant', 'pregnancy', 'pregnent', 'garbhvati', 'garbhavati', 'garbh', 'गर्भवती', 'गर्भ', 'प्रेगनेंट'], ['bleeding', 'spotting', 'severe pain', 'water broke', 'khoon', 'खून', 'तेज दर्द']] },
  // self-harm
  { category: 'SELF_HARM', all: [['kill myself', 'killing myself', 'kill herself', 'kill himself', 'kill themselves', 'suicide', 'suicidal', 'end my life', 'end it all', 'want to die', 'wanna die', 'dont want to live', 'no reason to live', 'better off dead', 'hurt myself', 'harm myself', 'self harm', 'cut myself', 'marna chahta', 'marna chahti', 'mar jana chahta', 'mar jana chahti', 'jeena nahi chahta', 'jeena nahi chahti', 'khudkushi', 'aatmhatya', 'atmahatya', 'आत्महत्या', 'खुदकुशी', 'मरना चाहत', 'मर जाना चाहत', 'जीना नहीं चाहत', 'जान दे']] },
  // unconscious, seizure
  { category: 'UNCONSCIOUS', all: [['unconscious', 'not responding', 'unresponsive', 'wont wake up', 'not waking up', 'passed out', 'collapsed', 'fainted', 'seizure', 'seizures', 'convulsions', 'convulsing', 'having a fit', 'behosh', 'behoshi', 'mirgi', 'बेहोश', 'होश नहीं', 'मिर्गी', 'दौरा पड़', 'झटके']] },
  // poisoning, overdose
  { category: 'POISONING', all: [['poison', 'poisoning', 'poisoned', 'overdose', 'overdosed', 'too many pills', 'too many sleeping pills', 'too many tablets', 'swallowed bleach', 'drank bleach', 'pesticide', 'rat poison', 'zeher', 'zehar', 'jahar', 'keetnashak', 'ज़हर', 'जहर', 'कीटनाशक']] },
  // severe allergy
  { category: 'ALLERGY', all: [['throat swelling', 'throat is swelling', 'throat closing', 'throat is closing', 'tongue swelling', 'swollen tongue', 'anaphylaxis', 'anaphylactic', 'severe allergic reaction', 'gala band', 'gale mein sujan', 'गला बंद', 'गले में सूजन']] },
  // serious injury
  { category: 'INJURY', all: [['road accident', 'car accident', 'bike accident', 'serious accident', 'head injury', 'hit my head', 'hit his head', 'hit her head', 'fell from', 'badly burned', 'severe burn', 'electric shock', 'snake bite', 'snakebite', 'dog bite', 'stabbed', 'gunshot', 'accident ho gaya', 'sar pe chot', 'saanp ne kaat', 'सांप ने काट', 'साँप ने काट', 'एक्सीडेंट', 'सिर पर चोट', 'बुरी तरह जल']] },
];

/** lower case, NFKC, apostrophes dropped ("can't" → "cant"), common phrasings unified, Devanagari nukta/chandrabindu folded */
export function normaliseText(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/़/g, '').replace(/ँ/g, 'ं')
    .replace(/\b(cannot|can not|unable to|not able to|cant able to)\b/g, 'cant')
    .replace(/\b(dont|do not)\b/g, 'dont').replace(/\b(wont|will not)\b/g, 'wont')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

function close(a: string, b: string) {
  if (a === b) return true;
  // swapped neighbours from 4 letters ("pian" → pain), other single edits from 5 ("sudenly" → suddenly)
  if (a.length === b.length && a.length >= 4) {
    const i = [...a].findIndex((ch, k) => ch !== b[k]);
    if (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return true;
  }
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  // Damerau-Levenshtein ≤ 1 (one insert, delete, substitute or swap of neighbours)
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

const DEVANAGARI = /[ऀ-ॿ]/;
function termMatches(term: string, text: string, words: string[]) {
  if (DEVANAGARI.test(term)) return text.includes(term.replace(/़/g, '').replace(/ँ/g, 'ं'));
  const t = term.split(' ');
  for (let i = 0; i + t.length <= words.length; i++) if (t.every((w, k) => close(w, words[i + k]))) return true;
  return false;
}

export interface EmergencyHit { category: EmergencyCategory }

export function checkEmergency(message: string): EmergencyHit | null {
  const text = normaliseText(message);
  const words = text.split(' ');
  for (const r of RULES) if (r.all.every((group) => group.some((term) => termMatches(term, text, words)))) return { category: r.category };
  return null;
}

export const detectLanguage = (text: string) => (DEVANAGARI.test(text) ? 'hi' : 'en');

/** The fixed emergency reply (never written by the model). The hospital's own emergency information is appended. */
/** `MODEL`: the model recognised an emergency the rules did not (general reply). */
export function emergencyReply(category: EmergencyCategory | 'MODEL', language: string, hospitalInfo: string | null): string {
  const hi = language === 'hi';
  const lines = hi
    ? ['यह आपातकाल हो सकता है।', 'अभी 112 पर कॉल करें (एम्बुलेंस: 108), या तुरंत नज़दीकी इमरजेंसी में जाएँ।']
    : ['This could be an emergency.', 'Call 112 now (ambulance: 108), or go to the nearest emergency department straight away.'];
  if (category === 'SELF_HARM') lines.push(hi ? 'आप अकेले नहीं हैं। Tele-MANAS से अभी बात करें: 14416 (24 घंटे, मुफ़्त)।' : 'You are not alone. Talk to Tele-MANAS now: 14416 (24 hours, free).');
  if (category === 'CARDIAC') lines.push(hi ? 'चलें-फिरें नहीं, बैठ जाएँ और किसी को अपने पास रहने को कहें।' : 'Do not walk around: sit down and ask someone to stay with you.');
  if (category === 'POISONING') lines.push(hi ? 'जो चीज़ ली गई है उसका डिब्बा या पैकेट साथ ले जाएँ।' : 'Take the container or packet of what was taken with you.');
  if (hospitalInfo) lines.push(hospitalInfo);
  lines.push(hi ? 'मैं एक AI सहायक हूँ और आपातकाल में मदद नहीं कर सकता।' : 'I am an AI assistant and cannot help in an emergency.');
  return lines.join('\n');
}
