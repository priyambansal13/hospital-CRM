import { Injectable } from '@nestjs/common';
import { checkValues, type FieldDef, type FieldValue } from '@mc/contracts';
import { DomainError } from './errors.js';

export interface FormDef { id: string; name: string; specialtyCode: string | null; intro: string | null; fields: FieldDef[]; version: number }
const base = () => process.env.SVC_URL_INTEGRATION ?? 'http://localhost:4416';
const headers = () => ({ 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' });

/**
 * Custom field and form definitions from integration-service (Phase 27), for the services that store the values.
 * Cached 30 s per hospital. integration-service down → writes are refused (502), reads still show stored values.
 */
@Injectable()
export class CustomFieldsClient {
  private readonly cache = new Map<string, { at: number; defs: FieldDef[] }>();

  async defs(tenantId: string, entity: 'PATIENT' | 'APPOINTMENT'): Promise<FieldDef[]> {
    const key = `${tenantId}:${entity}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.defs;
    const res = await fetch(`${base()}/internal/tenants/${tenantId}/custom-fields?entity=${entity}`, { headers: headers(), signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!res?.ok) throw new DomainError(502, 'FIELDS_UNAVAILABLE', 'custom fields are unavailable right now; try again shortly');
    const defs = (await res.json()) as FieldDef[];
    this.cache.set(key, { at: Date.now(), defs });
    return defs;
  }

  /**
   * Merge a change into the stored values: keys sent replace (empty clears), keys not sent are kept. Values of fields
   * switched off since are kept as they are (not re-validated, still visible as history).
   */
  async merge(tenantId: string, entity: 'PATIENT' | 'APPOINTMENT', current: Record<string, FieldValue>, change: Record<string, unknown>) {
    const defs = await this.defs(tenantId, entity);
    const active = new Set(defs.map((d) => d.key));
    const next: Record<string, unknown> = Object.fromEntries(Object.entries(current).filter(([k]) => active.has(k)));
    Object.assign(next, change);
    const r = checkValues(defs, next);
    if (!r.ok) throw new DomainError(400, 'VALIDATION_FAILED', 'some fields are not valid', { errors: r.errors });
    const retired = Object.fromEntries(Object.entries(current).filter(([k]) => !active.has(k)));
    return { ...retired, ...r.values };
  }

  async formFor(tenantId: string, specialties: string[]): Promise<FormDef | null> {
    const res = await fetch(`${base()}/internal/tenants/${tenantId}/forms/for-visit?specialties=${encodeURIComponent(specialties.join(','))}`, { headers: headers(), signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!res?.ok) throw new DomainError(502, 'FORMS_UNAVAILABLE', 'forms are unavailable right now; try again shortly');
    return ((await res.json()) as { form: FormDef | null }).form;
  }

  async form(tenantId: string, formId: string): Promise<FormDef | null> {
    const res = await fetch(`${base()}/internal/tenants/${tenantId}/forms/${formId}`, { headers: headers(), signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (res?.status === 404) return null;
    if (!res?.ok) throw new DomainError(502, 'FORMS_UNAVAILABLE', 'forms are unavailable right now; try again shortly');
    return (await res.json()) as FormDef;
  }
}
