import type { FieldDef } from '@mc/forms';

export interface CustomField extends FieldDef { id: string; entity: 'PATIENT' | 'APPOINTMENT'; active: boolean; sort: number; version: number }
export interface Form { id: string; name: string; specialtyCode: string | null; intro: string | null; fields: FieldDef[]; active: boolean; version: number }
export const TYPES: { value: FieldDef['type']; label: string }[] = [
  { value: 'TEXT', label: 'Text' }, { value: 'NUMBER', label: 'Number' }, { value: 'DATE', label: 'Date' }, { value: 'SELECT', label: 'Choice' }, { value: 'BOOLEAN', label: 'Yes / no' },
];
const TYPE_WORDS: Record<string, FieldDef['type']> = { text: 'TEXT', number: 'NUMBER', date: 'DATE', choice: 'SELECT', select: 'SELECT', yesno: 'BOOLEAN', 'yes/no': 'BOOLEAN', boolean: 'BOOLEAN' };

/** "Referral source" → "referral_source" (the stored key; never changes). */
export const keyOf = (label: string) => {
  const k = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z]/.test(k) ? k : `q_${k}`.slice(0, 40);
};

/**
 * A form's questions, one per line: `Question | type | options, comma separated | required`. Type and the rest are
 * optional (text). Keys come from the questions; a question that already exists keeps its key.
 */
export function parseQuestions(text: string, existing: FieldDef[] = []): { fields: FieldDef[]; error?: string } {
  const fields: FieldDef[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const [label, typeWord = 'text', opts = '', flag = ''] = line.split('|').map((p) => p.trim());
    const type = TYPE_WORDS[typeWord.toLowerCase().replace(/\s/g, '')];
    if (!label) return { fields, error: `line ${i + 1}: the question is empty` };
    if (!type) return { fields, error: `line ${i + 1}: "${typeWord}" is not a type (text, number, date, choice, yes/no)` };
    const prev = existing.find((f) => f.label === label);
    fields.push({ key: prev?.key ?? keyOf(label), label, type, options: type === 'SELECT' ? opts.split(',').map((o) => o.trim()).filter(Boolean) : [], required: /^req/i.test(flag || (type === 'SELECT' ? '' : opts)), help: null });
  }
  return { fields };
}

export const questionsText = (fields: FieldDef[]) =>
  fields.map((f) => [f.label, TYPES.find((t) => t.value === f.type)!.label.toLowerCase().replace(' / ', '/'), f.type === 'SELECT' ? f.options.join(', ') : '', f.required ? 'required' : ''].filter((p, i) => p || i < 3).join(' | ').replace(/( \| )+$/, '')).join('\n');
