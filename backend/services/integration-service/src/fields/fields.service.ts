import { Injectable } from '@nestjs/common';
import { FieldDef } from '@mc/contracts';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { conflict, DomainError, notFound } from '@mc/nest-common';
import { type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';

export type Entity = 'PATIENT' | 'APPOINTMENT';
export const toField = (r: any) => ({ id: r.id, entity: r.entity as Entity, key: r.key, label: r.label, type: r.type, options: r.options as string[], required: r.required, help: r.help, active: r.active, sort: r.sort, version: r.version });
export const toForm = (r: any) => ({ id: r.id, name: r.name, specialtyCode: r.specialty_code as string | null, intro: r.intro as string | null, fields: r.fields as FieldDef[], active: r.active, version: r.version });

/**
 * Custom field and form definitions (Phase 27). The values live with their records (patient-service,
 * scheduling-service), which read these definitions through the internal endpoint and validate with
 * `checkValues` (@mc/contracts). A field's key and type never change once created (old values stay readable);
 * a field is retired by deactivating it.
 */
@Injectable()
export class FieldsService {
  constructor(private readonly db: TenantDbRouter, private readonly entitlements: EntitlementsClient) {}

  private async limit(c: Queryable, feature: string, table: 'field_defs' | 'forms', excludingId: string | null, what: string) {
    const f = (await this.entitlements.tenantFeatures(TenantContext.require().id)).features[feature];
    if (f?.limit == null) return;
    const { rows: [r] } = await c.query(`SELECT count(*)::int n FROM ${table} WHERE active AND ($1::uuid IS NULL OR id <> $1)`, [excludingId]);
    if (r.n >= f.limit) throw new DomainError(422, 'LIMIT_REACHED', `your plan allows ${f.limit} active ${what}: switch one off first`, { limit: f.limit });
  }

  async fields(entity?: Entity, onlyActive = false) {
    const { rows } = await this.db.query(`SELECT * FROM field_defs WHERE ($1::text IS NULL OR entity = $1) ${onlyActive ? 'AND active' : ''} ORDER BY entity, sort, created_at`, [entity ?? null]);
    return rows.map(toField);
  }

  async createField(v: FieldDef & { entity: Entity; sort: number }) {
    return this.db.tx(async (c) => {
      await this.limit(c, 'workflows.custom_fields', 'field_defs', null, 'custom fields');
      const { rows: [dup] } = await c.query('SELECT 1 FROM field_defs WHERE entity = $1 AND key = $2', [v.entity, v.key]);
      if (dup) throw conflict('KEY_TAKEN', `there is already a ${v.entity.toLowerCase()} field "${v.key}"`);
      const { rows: [r] } = await c.query(
        `INSERT INTO field_defs (id, entity, key, label, type, options, required, help, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [randomUUID(), v.entity, v.key, v.label, v.type, JSON.stringify(v.options), v.required, v.help, v.sort]);
      return toField(r);
    });
  }

  /** Label, options, required, help, order and on/off; options can only be added (existing values stay valid). */
  async updateField(id: string, v: { label?: string; options?: string[]; required?: boolean; help?: string | null; active?: boolean; sort?: number; version: number }) {
    return this.db.tx(async (c) => {
      const { rows: [f] } = await c.query('SELECT * FROM field_defs WHERE id = $1 FOR UPDATE', [id]);
      if (!f) throw notFound('custom field');
      if (f.version !== v.version) throw conflict('VERSION_CONFLICT', 'this field changed in another window; reload');
      if (v.active === true && !f.active) await this.limit(c, 'workflows.custom_fields', 'field_defs', id, 'custom fields');
      if (v.options && f.type === 'SELECT') {
        const removed = (f.options as string[]).filter((o) => !v.options!.includes(o));
        if (removed.length) throw new DomainError(422, 'OPTION_IN_USE', `options cannot be removed (records may use them): ${removed.join(', ')}`);
      }
      const { rows: [r] } = await c.query(
        `UPDATE field_defs SET label = coalesce($2, label), options = coalesce($3, options), required = coalesce($4, required), help = CASE WHEN $5 THEN $6 ELSE help END,
           active = coalesce($7, active), sort = coalesce($8, sort), version = version + 1 WHERE id = $1 RETURNING *`,
        [id, v.label ?? null, v.options && f.type === 'SELECT' ? JSON.stringify(v.options) : null, v.required ?? null, v.help !== undefined, v.help ?? null, v.active ?? null, v.sort ?? null]);
      return toField(r);
    });
  }

  async forms(onlyActive = false) {
    const { rows } = await this.db.query(`SELECT * FROM forms ${onlyActive ? 'WHERE active' : ''} ORDER BY specialty_code NULLS FIRST, name`);
    return rows.map(toForm);
  }

  /** The form for a visit: the doctor's specialty's form, else the one for every visit. */
  async formFor(specialtyCodes: string[]) {
    const { rows } = await this.db.query(`SELECT * FROM forms WHERE active AND (specialty_code IS NULL OR specialty_code = ANY($1)) ORDER BY specialty_code NULLS LAST LIMIT 1`, [specialtyCodes]);
    return rows[0] ? toForm(rows[0]) : null;
  }

  async form(id: string) {
    const { rows: [r] } = await this.db.query('SELECT * FROM forms WHERE id = $1', [id]);
    if (!r) throw notFound('form');
    return toForm(r);
  }

  private uniqueKeys(fields: FieldDef[]) {
    const seen = new Set<string>();
    for (const f of fields) { if (seen.has(f.key)) throw new DomainError(422, 'DUPLICATE_KEY', `two questions use the key "${f.key}"`); seen.add(f.key); }
  }

  private async onePerSpecialty(c: Queryable, specialty: string | null, excludingId: string | null) {
    const { rows: [r] } = await c.query(`SELECT name FROM forms WHERE active AND coalesce(specialty_code, '*') = coalesce($1, '*') AND ($2::uuid IS NULL OR id <> $2)`, [specialty, excludingId]);
    if (r) throw conflict('FORM_EXISTS', `"${r.name}" is already the active form ${specialty ? `for ${specialty}` : 'for every visit'}: switch it off first`);
  }

  async createForm(v: { name: string; specialtyCode: string | null; intro: string | null; fields: FieldDef[] }) {
    this.uniqueKeys(v.fields);
    return this.db.tx(async (c) => {
      await this.limit(c, 'workflows.forms', 'forms', null, 'forms');
      await this.onePerSpecialty(c, v.specialtyCode, null);
      const { rows: [r] } = await c.query(`INSERT INTO forms (id, name, specialty_code, intro, fields) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [randomUUID(), v.name, v.specialtyCode, v.intro, JSON.stringify(v.fields)]);
      return toForm(r);
    });
  }

  /** Answers already given keep the questions they answered (they are stored with the answers). */
  async updateForm(id: string, v: { name?: string; intro?: string | null; fields?: FieldDef[]; active?: boolean; version: number }) {
    if (v.fields) this.uniqueKeys(v.fields);
    return this.db.tx(async (c) => {
      const { rows: [f] } = await c.query('SELECT * FROM forms WHERE id = $1 FOR UPDATE', [id]);
      if (!f) throw notFound('form');
      if (f.version !== v.version) throw conflict('VERSION_CONFLICT', 'this form changed in another window; reload');
      if (v.active === true && !f.active) {
        await this.limit(c, 'workflows.forms', 'forms', id, 'forms');
        await this.onePerSpecialty(c, f.specialty_code, id);
      }
      const { rows: [r] } = await c.query(
        `UPDATE forms SET name = coalesce($2, name), intro = CASE WHEN $3 THEN $4 ELSE intro END, fields = coalesce($5, fields), active = coalesce($6, active), version = version + 1 WHERE id = $1 RETURNING *`,
        [id, v.name ?? null, v.intro !== undefined, v.intro ?? null, v.fields ? JSON.stringify(v.fields) : null, v.active ?? null]);
      return toForm(r);
    });
  }
}
