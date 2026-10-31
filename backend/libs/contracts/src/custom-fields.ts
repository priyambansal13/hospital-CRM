import { z } from 'zod';

/**
 * Custom fields and forms (Phase 27). A hospital defines extra fields on patients and appointments, and short forms
 * patients fill before a visit. integration-service owns the definitions; the service that owns the record stores
 * the values (a `custom_fields` / `form_answers` JSONB column) and validates them with `checkValues` below.
 */
export const FieldKey = z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, 'lowercase letters, digits and _ (start with a letter)');
export const FieldDef = z.object({
  key: FieldKey,
  label: z.string().trim().min(1).max(80),
  type: z.enum(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN']),
  options: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  required: z.boolean().default(false),
  help: z.string().trim().max(200).nullable().default(null),
}).refine((f) => f.type !== 'SELECT' || f.options.length >= 2, { message: 'a choice field needs at least two options', path: ['options'] });
export type FieldDef = z.infer<typeof FieldDef>;
export type FieldValue = string | number | boolean | null;

/**
 * Values checked against definitions: unknown keys are refused, empty values dropped (unless required), each value
 * coerced to its type (form posts arrive as strings). Returns the clean values or the problems, path = the key.
 */
export function checkValues(defs: FieldDef[], input: Record<string, unknown>): { ok: true; values: Record<string, FieldValue> } | { ok: false; errors: { path: string; message: string }[] } {
  const errors: { path: string; message: string }[] = [];
  const values: Record<string, FieldValue> = {};
  const known = new Map(defs.map((d) => [d.key, d]));
  for (const k of Object.keys(input)) if (!known.has(k)) errors.push({ path: k, message: 'not a field of this hospital' });
  for (const d of defs) {
    const raw = input[d.key];
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (empty) {
      if (d.type === 'BOOLEAN' && raw !== undefined && !d.required) { values[d.key] = false; continue; }
      if (d.required) errors.push({ path: d.key, message: `${d.label} is required` });
      continue;
    }
    const s = typeof raw === 'string' ? raw.trim() : raw;
    switch (d.type) {
      case 'TEXT':
        if (typeof s !== 'string' || s.length > 500) errors.push({ path: d.key, message: `${d.label}: at most 500 characters` }); else values[d.key] = s;
        break;
      case 'NUMBER': {
        const n = typeof s === 'number' ? s : Number(s);
        if (!Number.isFinite(n) || Math.abs(n) > 1e12) errors.push({ path: d.key, message: `${d.label} must be a number` }); else values[d.key] = n;
        break;
      }
      case 'DATE':
        if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) errors.push({ path: d.key, message: `${d.label} must be a date (YYYY-MM-DD)` }); else values[d.key] = s;
        break;
      case 'SELECT':
        if (typeof s !== 'string' || !d.options.includes(s)) errors.push({ path: d.key, message: `${d.label}: choose one of ${d.options.join(', ')}` }); else values[d.key] = s;
        break;
      case 'BOOLEAN': {
        const b = s === true || s === 'true' || s === 'on' || s === 'yes' ? true : s === false || s === 'false' || s === 'off' || s === 'no' ? false : null;
        if (b === null) errors.push({ path: d.key, message: `${d.label} must be yes or no` }); else if (d.required && !b) errors.push({ path: d.key, message: `${d.label} must be ticked` }); else values[d.key] = b;
        break;
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}
