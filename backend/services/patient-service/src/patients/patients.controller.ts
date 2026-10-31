import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { EventTypes, type PatientRegistered, Topics } from '@mc/contracts';
import { conflict, CurrentActor, DomainError, forbidden, Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, addToOutbox, envelope, type PlacementSource, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const Person = {
  fullName: z.string().trim().min(2).max(120),
  dob: z.iso.date().refine((d) => d <= new Date().toISOString().slice(0, 10), 'date of birth cannot be in the future'),
  gender: z.enum(['FEMALE', 'MALE', 'OTHER']).nullable(),
};
export const SelfProfile = z.object({ ...Person, gender: Person.gender.default(null), email: z.email().nullable().default(null) });
export const NewDependent = z.object({ ...Person, gender: Person.gender.default(null), relation: z.enum(['CHILD', 'SPOUSE', 'PARENT', 'SIBLING', 'OTHER']) });
export const UpdateDependent = z.object({ ...Person, relation: NewDependent.shape.relation }).partial().extend({ version: z.number().int() });

export const toDto = (r: any) => ({ id: r.id, mrn: r.mrn, fullName: r.full_name, dob: r.dob, gender: r.gender, relation: r.relation, isSelf: r.guardian_id === null, phone: r.phone, email: r.email, version: r.version });
/** staff and other services also see the hospital's custom fields and workflow tags (not shown to patients) */
export const staffDto = (r: any) => ({ ...toDto(r), customFields: (r.custom_fields ?? {}) as Record<string, unknown>, tags: (r.tags ?? []) as string[] });
export const DOB = `to_char(dob, 'YYYY-MM-DD') AS dob`;

function requirePatient(actor: Actor) {
  if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'sign in as a patient to manage patient profiles');
}

export async function nextMrn(c: Queryable) {
  const { rows } = await c.query(`SELECT 'MRN' || nextval('mrn_seq') AS mrn`);
  return rows[0].mrn as string;
}

/** The signed-in patient's own record and family members, in this hospital. */
@Controller('v1/me')
export class MyPatientsController {
  constructor(private readonly db: TenantDbRouter) {}

  @Get('patients')
  @RequirePermission('profile:manage:own')
  async list(@CurrentActor() actor: Actor) {
    requirePatient(actor);
    const { rows } = await this.db.query(`SELECT *, ${DOB} FROM patients WHERE account_person_id = $1 ORDER BY guardian_id NULLS FIRST, full_name`, [actor.id]);
    return rows.map(toDto);
  }

  /** Create or update the account holder's own record. */
  @Put('profile')
  @RequirePermission('profile:manage:own')
  async upsertSelf(@Body() body: unknown, @CurrentActor() actor: Actor) {
    requirePatient(actor);
    const input = parse(SelfProfile, body);
    const phone = await this.phoneOf(actor);
    return this.db.tx(async (c) => {
      const existing = await c.query('SELECT id FROM patients WHERE account_person_id = $1 AND guardian_id IS NULL', [actor.id]);
      if (existing.rows[0]) {
        const { rows } = await c.query(
          `UPDATE patients SET full_name = $2, dob = $3, gender = $4, email = $5, phone = coalesce(phone, $6), version = version + 1, updated_at = now() WHERE id = $1 RETURNING *, ${DOB}`,
          [existing.rows[0].id, input.fullName, input.dob, input.gender, input.email, phone],
        );
        await this.announce(c, rows[0], EventTypes.patientUpdated);
        return toDto(rows[0]);
      }
      const { rows } = await c.query(
        `INSERT INTO patients (id, account_person_id, relation, mrn, full_name, dob, gender, phone, email) VALUES ($1,$2,'SELF',$3,$4,$5,$6,$7,$8) RETURNING *, ${DOB}`,
        [randomUUID(), actor.id, await nextMrn(c), input.fullName, input.dob, input.gender, phone, input.email],
      );
      await this.announce(c, rows[0]);
      return toDto(rows[0]);
    });
  }

  @Post('dependents')
  @RequirePermission('profile:manage:own')
  async addDependent(@Body() body: unknown, @CurrentActor() actor: Actor) {
    requirePatient(actor);
    const input = parse(NewDependent, body);
    return this.db.tx(async (c) => {
      const self = await c.query('SELECT id, phone FROM patients WHERE account_person_id = $1 AND guardian_id IS NULL', [actor.id]);
      if (!self.rows[0]) throw new DomainError(422, 'PROFILE_REQUIRED', 'complete your own profile first');
      const { rowCount } = await c.query('SELECT 1 FROM patients WHERE account_person_id = $1', [actor.id]);
      if ((rowCount ?? 0) >= 10) throw new DomainError(422, 'TOO_MANY_DEPENDENTS', 'an account can manage at most 9 family members');
      const dup = await c.query('SELECT 1 FROM patients WHERE account_person_id = $1 AND lower(full_name) = lower($2) AND dob = $3', [actor.id, input.fullName, input.dob]);
      if (dup.rowCount) throw conflict('DEPENDENT_EXISTS', 'this family member is already added');
      const { rows } = await c.query(
        `INSERT INTO patients (id, account_person_id, guardian_id, relation, mrn, full_name, dob, gender, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *, ${DOB}`,
        [randomUUID(), actor.id, self.rows[0].id, input.relation, await nextMrn(c), input.fullName, input.dob, input.gender, self.rows[0].phone],
      );
      await this.announce(c, rows[0]);
      return toDto(rows[0]);
    });
  }

  @Patch('dependents/:id')
  @RequirePermission('profile:manage:own')
  async updateDependent(@Param('id') id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    requirePatient(actor);
    if (!z.uuid().safeParse(id).success) throw notFound('family member');
    const input = parse(UpdateDependent, body);
    const { rows } = await this.db.query(
      `UPDATE patients SET full_name = coalesce($4, full_name), dob = coalesce($5::date, dob), gender = coalesce($6, gender), relation = coalesce($7, relation),
         version = version + 1, updated_at = now()
       WHERE id = $1 AND account_person_id = $2 AND guardian_id IS NOT NULL AND version = $3 RETURNING *, ${DOB}`,
      [id, actor.id, input.version, input.fullName ?? null, input.dob ?? null, input.gender ?? null, input.relation ?? null],
    );
    if (!rows[0]) {
      const exists = await this.db.query('SELECT 1 FROM patients WHERE id = $1 AND account_person_id = $2', [id, actor.id]);
      throw exists.rowCount ? conflict('VERSION_CONFLICT', 'changed elsewhere; reload and retry') : notFound('family member');
    }
    return toDto(rows[0]);
  }

  private async phoneOf(actor: Actor) {
    // the phone was verified at sign-in; iam keeps it in this hospital's account row
    const res = await fetch(`${process.env.SVC_URL_IAM ?? 'http://localhost:4402'}/v1/me`, { headers: { authorization: `Bearer ${actor.token}`, 'x-tenant-host': TenantContext.require().hosts[0] } });
    return res.ok ? ((await res.json()) as { phone?: string }).phone ?? null : null;
  }

  private announce(c: Queryable, r: any, type: string = EventTypes.patientRegistered) {
    return announcePatient(c, r, type);
  }
}

export async function announcePatient(c: Queryable, r: any, type: string = EventTypes.patientRegistered) {
  const data: PatientRegistered = { patientId: r.id, accountPersonId: r.account_person_id, guardianId: r.guardian_id, mrn: r.mrn, name: r.full_name, phone: r.phone, email: r.email, dob: r.dob ? String(r.dob).slice(0, 10) : null, gender: r.gender };
  await addToOutbox(c, Topics.patient, r.id, envelope(type, data, { tenantId: TenantContext.require().id, subject: r.id }));
}

/**
 * Service-to-service: may this person act for this patient? Used by scheduling-service when booking.
 * Returns the patient (name, MRN) or 404 — never another account's patient.
 */
@Controller('internal/tenants/:tenantId/patients')
export class InternalPatientsController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get(':patientId/access/:personId')
  @Internal()
  async access(@Param('tenantId') tenantId: string, @Param('patientId') patientId: string, @Param('personId') personId: string) {
    for (const v of [tenantId, patientId, personId]) if (!z.uuid().safeParse(v).success) throw notFound('patient');
    return TenantContext.run(await this.placements.get(tenantId), async () => {
      const { rows } = await this.db.query(`SELECT *, ${DOB} FROM patients WHERE id = $1 AND account_person_id = $2`, [patientId, personId]);
      if (!rows[0]) throw notFound('patient');
      return { ...toDto(rows[0]), accountPersonId: rows[0].account_person_id };
    });
  }

  /** Active allergies for the prescription check in records-service (substance and severity only). */
  @Get(':patientId/allergies')
  @Internal()
  async allergies(@Param('tenantId') tenantId: string, @Param('patientId') patientId: string) {
    for (const v of [tenantId, patientId]) if (!z.uuid().safeParse(v).success) throw notFound('patient');
    return TenantContext.run(await this.placements.get(tenantId), async () => {
      const { rows } = await this.db.query('SELECT substance, severity FROM allergies WHERE patient_id = $1 AND removed_at IS NULL', [patientId]);
      return rows.map((r) => ({ substance: r.substance as string, severity: r.severity as string }));
    });
  }

  /** A patient by MRN (integration-service's FHIR API, Phase 27). */
  @Get('by-mrn/:mrn')
  @Internal()
  async byMrn(@Param('tenantId') tenantId: string, @Param('mrn') mrn: string) {
    if (!z.uuid().safeParse(tenantId).success || !/^MRN\d{1,12}$/i.test(mrn)) throw notFound('patient');
    return TenantContext.run(await this.placements.get(tenantId), async () => {
      const { rows } = await this.db.query(`SELECT *, ${DOB} FROM patients WHERE mrn = upper($1)`, [mrn]);
      if (!rows[0]) throw notFound('patient');
      return { ...staffDto(rows[0]), accountPersonId: rows[0].account_person_id };
    });
  }

  /** A patient by id (front-desk booking: the caller has already checked the staff member's permission). */
  @Get(':patientId')
  @Internal()
  async get(@Param('tenantId') tenantId: string, @Param('patientId') patientId: string) {
    for (const v of [tenantId, patientId]) if (!z.uuid().safeParse(v).success) throw notFound('patient');
    return TenantContext.run(await this.placements.get(tenantId), async () => {
      const { rows } = await this.db.query(`SELECT *, ${DOB} FROM patients WHERE id = $1`, [patientId]);
      if (!rows[0]) throw notFound('patient');
      return { ...staffDto(rows[0]), accountPersonId: rows[0].account_person_id };
    });
  }

  /** A workflow rule's "tag the patient" action (Phase 27): idempotent, at most 20 tags. */
  @Post(':patientId/tags')
  @Internal()
  @HttpCode(200)
  async tag(@Param('tenantId') tenantId: string, @Param('patientId') patientId: string, @Body() body: unknown) {
    for (const v of [tenantId, patientId]) if (!z.uuid().safeParse(v).success) throw notFound('patient');
    const { tag } = parse(z.object({ tag: z.string().trim().min(1).max(40) }), body);
    return TenantContext.run(await this.placements.get(tenantId), async () => {
      const { rows } = await this.db.query(
        `UPDATE patients SET tags = CASE WHEN $2 = ANY(tags) OR cardinality(tags) >= 20 THEN tags ELSE array_append(tags, $2) END WHERE id = $1 RETURNING tags`, [patientId, tag]);
      if (!rows[0]) throw notFound('patient');
      return { tags: rows[0].tags as string[] };
    });
  }

  /** Re-announce every patient (rebuilds other services' read models after an event schema change). */
  @Post('republish')
  @Internal()
  async republish(@Param('tenantId') tenantId: string) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    return TenantContext.run(await this.placements.get(tenantId), () => this.db.tx(async (c) => {
      const { rows } = await c.query(`SELECT *, ${DOB} FROM patients ORDER BY guardian_id NULLS FIRST`);
      for (const r of rows) {
        const data: PatientRegistered = { patientId: r.id, accountPersonId: r.account_person_id, guardianId: r.guardian_id, mrn: r.mrn, name: r.full_name, phone: r.phone, email: r.email, dob: r.dob ? String(r.dob).slice(0, 10) : null, gender: r.gender };
        await addToOutbox(c, Topics.patient, r.id, envelope(EventTypes.patientUpdated, data, { tenantId, subject: r.id }));
      }
      return { republished: rows.length };
    }));
  }
}
