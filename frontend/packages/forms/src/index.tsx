import { Field, Select } from '@mc/ui';

/**
 * Custom fields and forms (Phase 27): the same field definitions as @mc/contracts `FieldDef`, rendered as inputs
 * (named `f_<key>`) and as a read-only list. Works without JavaScript (plain form posts).
 */
export interface FieldDef { key: string; label: string; type: 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'BOOLEAN'; options: string[]; required: boolean; help: string | null }
export type Values = Record<string, string | number | boolean | null | undefined>;
export const PREFIX = 'f_';

export function FieldInputs({ defs, values = {} }: { defs: FieldDef[]; values?: Values }) {
  return (
    <>
      {defs.map((d) => {
        const v = values[d.key];
        const name = `${PREFIX}${d.key}`;
        const label = d.required ? `${d.label} *` : d.label;
        if (d.type === 'SELECT') {
          return <Select key={d.key} label={label} name={name} required={d.required} defaultValue={v == null ? '' : String(v)} options={[{ value: '', label: 'Choose…' }, ...d.options.map((o) => ({ value: o, label: o }))]} />;
        }
        if (d.type === 'BOOLEAN') {
          return (
            <label key={d.key} className="mc-radio mc-field-wide">
              <input type="hidden" name={name} value="false" />
              <input type="checkbox" name={name} value="true" defaultChecked={v === true} /> <span>{label}{d.help ? <span className="mc-meta"> · {d.help}</span> : null}</span>
            </label>
          );
        }
        return <Field key={d.key} label={label} name={name} type={d.type === 'NUMBER' ? 'number' : d.type === 'DATE' ? 'date' : 'text'} required={d.required} defaultValue={v == null ? '' : String(v)} hint={d.help ?? undefined} />;
      })}
    </>
  );
}

const show = (d: FieldDef, v: Values[string]) => (v == null || v === '' ? '—' : d.type === 'BOOLEAN' ? (v ? 'Yes' : 'No') : String(v));

export function FieldValues({ defs, values, empty = 'Nothing filled in yet.' }: { defs: FieldDef[]; values: Values; empty?: string }) {
  const known = defs.filter((d) => values[d.key] != null && values[d.key] !== '');
  if (!known.length) return <p className="mc-empty">{empty}</p>;
  return (
    <dl className="mc-summary">
      {known.map((d) => <div key={d.key} style={{ display: 'contents' }}><dt>{d.label}</dt><dd>{show(d, values[d.key])}</dd></div>)}
    </dl>
  );
}

/**
 * The `f_<key>` entries of a posted form, as values for the API. A ticked checkbox posts "false" (hidden) and "true":
 * the last one wins. Empty strings are sent (they clear the value).
 */
export function valuesFromForm(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith(PREFIX) && typeof v === 'string') out[k.slice(PREFIX.length)] = v;
  return out;
}
