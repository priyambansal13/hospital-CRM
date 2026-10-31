import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { PhoneNumber } from '@mc/contracts';
import { conflict, CurrentActor, CustomFieldsClient, DomainError, notFound, parse } from '@mc/nest-common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditClient } from './audit.client.js';
import { announcePatient, DOB, nextMrn, staffDto, toDto } from './patients.controller.js';

export const DeskRegister = z.object({
  phone: PhoneNumber,
  fullName: z.string().trim().min(2).max(120),
  dob: z.iso.date().refine((d) => d <= new Date().toISOString().slice(0, 10), 'date of birth cannot be in the future'),
  gender: z.enum(['FEMALE', 'MALE', 'OTHER']).nullable().default(null),
  /** SELF = the phone's owner; anything else is a family member of the phone's owner (who must be registered first) */
  relation: z.enum(['SELF', 'CHILD', 'SPOUSE', 'PARENT', 'SIBLING', 'OTHER']).default('SELF'),
  email: z.email().nullable().default(null),
});
const Search = z.string().trim().min(2, 'type at least 2 characters').max(60);

/**
 * Front desk: find a patient by phone, MRN or name, and register walk-ins. A record is always tied to a phone
 * number (its owner's account), so the patient sees it after signing in with that phone.
 */
@Controller('v1/desk/patients')
@RequireModule('front_desk')
@RequirePermission('patient:register:branch')
export class DeskPatientsController {
  constructor(private readonly db: TenantDbRouter) {}

  @Get()
  async search(@Query('q') q: string | undefined) {
    const term = parse(Search, q ?? '');
    const phone = /^[+\d\s-]{10,}$/.test(term) ? PhoneNumber.safeParse(term) : undefined;
    let where: string;
    let arg: string;
    if (phone?.success) [where, arg] = ['phone = $1', phone.data];
    else if (/^mrn\d+$/i.test(term)) [where, arg] = ['mrn = upper($1)', term];
    else [where, arg] = [`lower(full_name) LIKE '%' || lower($1) || '%'`, term.replace(/[%_\\]/g, '')];
    const { rows } = await this.db.query(
      `SELECT p.*, ${DOB}, (SELECT full_name FROM patients h WHERE h.id = p.guardian_id) AS guardian_name
       FROM patients p WHERE ${where} ORDER BY p.phone, p.guardian_id NULLS FIRST, p.full_name LIMIT 25`, [arg]);
    return rows.map((r) => ({ ...staffDto(r), guardianName: r.guardian_name }));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('patient');
    const { rows } = await this.db.query(
      `SELECT p.*, ${DOB}, (SELECT full_name FROM patients h WHERE h.id = p.guardian_id) AS guardian_name FROM patients p WHERE p.id = $1`, [id]);
    if (!rows[0]) throw notFound('patient');
    return { ...staffDto(rows[0]), guardianName: rows[0].guardian_name };
  }

  @Post()
  async register(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const input = parse(DeskRegister, body);
    const personId = await ensurePerson(input.phone);
    return this.db.tx(async (c) => {
      const { rows: family } = await c.query(`SELECT *, ${DOB} FROM patients WHERE account_person_id = $1 ORDER BY guardian_id NULLS FIRST`, [personId]);
      const holder = family.find((r) => r.guardian_id === null);
      if (input.relation === 'SELF' && holder) {
        throw conflict('PHONE_ALREADY_REGISTERED', `${input.phone} already belongs to ${holder.full_name} (${holder.mrn}); add this person as a family member instead`, { holder: toDto(holder) });
      }
      if (input.relation !== 'SELF' && !holder) {
        throw new DomainError(422, 'HOLDER_REQUIRED', 'register the phone owner first, then add family members to their phone');
      }
      if (family.length >= 10) throw new DomainError(422, 'TOO_MANY_DEPENDENTS', 'a phone can have at most 9 family members');
      const dup = family.find((r) => r.full_name.toLowerCase() === input.fullName.toLowerCase() && r.dob === input.dob);
      if (dup) throw conflict('PATIENT_EXISTS', `${dup.full_name} is already registered (${dup.mrn})`, { patient: toDto(dup) });
      const { rows } = await c.query(
        `INSERT INTO patients (id, account_person_id, guardian_id, relation, mrn, full_name, dob, gender, phone, email, registered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *, ${DOB}`,
        [randomUUID(), personId, holder?.id ?? null, input.relation, await nextMrn(c), input.fullName, input.dob, input.gender, input.phone, input.relation === 'SELF' ? input.email : null, actor.id],
      );
      await announcePatient(c, rows[0]);
      return toDto(rows[0]);
    });
  }
}

async function ensurePerson(phone: string): Promise<string> {
  const res = await fetch(`${process.env.SVC_URL_IAM ?? 'http://localhost:4402'}/internal/persons`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, body: JSON.stringify({ phone }),
  });
  if (!res.ok) throw new DomainError(502, 'IAM_UNAVAILABLE', `iam-service ${res.status}`);
  return ((await res.json()) as { personId: string }).personId;
}

/**
 * The hospital's custom fields on a patient (Phase 27), filled in by the desk or nurses. Values are checked against
 * the definitions in integration-service; keys not sent are kept.
 */
@Controller('v1/patients')
@RequireModule('workflows')
@RequirePermission('custom_field:write:branch')
export class PatientFieldsController {
  constructor(private readonly db: TenantDbRouter, private readonly fields: CustomFieldsClient, private readonly audit: AuditClient) {}

  @Put(':id/custom-fields')
  async save(@Param('id') id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    if (!z.uuid().safeParse(id).success) throw notFound('patient');
    const { values, version } = parse(z.object({ values: z.record(z.string(), z.unknown()), version: z.number().int() }), body);
    const tenant = TenantContext.require();
    return this.db.tx(async (c) => {
      const { rows: [p] } = await c.query('SELECT * FROM patients WHERE id = $1 FOR UPDATE', [id]);
      if (!p) throw notFound('patient');
      if (p.version !== version) throw conflict('VERSION_CONFLICT', 'this patient changed in another window; reload');
      const next = await this.fields.merge(tenant.id, 'PATIENT', p.custom_fields ?? {}, values);
      const { rows } = await c.query(`UPDATE patients SET custom_fields = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *, ${DOB}`, [id, JSON.stringify(next)]);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: actor.email ?? null, action: 'UPDATE', resourceType: 'PATIENT_CUSTOM_FIELDS', resourceId: id, patientId: id, purpose: 'ADMIN', changes: Object.keys(values) });
      return staffDto(rows[0]);
    });
  }
}
