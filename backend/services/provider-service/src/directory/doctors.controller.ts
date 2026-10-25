import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { type DoctorChanged, EventTypes, Topics } from '@mc/contracts';
import { conflict, CurrentActor, DomainError, Idempotent, notFound, parse } from '@mc/nest-common';
import { assertWithinLimit, EntitlementsClient, RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DirectoryRepo, type DoctorDto } from './directory.repo.js';
import { IamClient } from './iam.client.js';

const Lang = z.string().trim().toLowerCase().regex(/^[a-z]{2,3}$/, 'ISO language code, e.g. en, hi');
const Mode = z.enum(['IN_PERSON', 'VIDEO']);
const BranchFee = z.object({ branchId: z.uuid(), fee: z.number().min(0).max(1_000_000), followupFee: z.number().min(0).max(1_000_000).nullable().optional() });
const SpecialtyRef = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/), primary: z.boolean().default(false) });

const Profile = {
  name: z.string().trim().min(2).max(120),
  gender: z.enum(['FEMALE', 'MALE', 'OTHER']).nullable(),
  qualifications: z.array(z.string().trim().min(1).max(80)).max(10),
  experienceYears: z.number().int().min(0).max(70).nullable(),
  languages: z.array(Lang).max(10),
  bio: z.string().trim().max(2000).nullable(),
  consultModes: z.array(Mode).min(1),
  specialties: z.array(SpecialtyRef).min(1).max(5),
  branches: z.array(BranchFee).min(1).max(50),
};
export const CreateDoctor = z.object({
  ...Profile,
  email: z.email().transform((e) => e.toLowerCase()),
  registrationNo: z.string().trim().min(3).max(40),
  gender: Profile.gender.default(null),
  qualifications: Profile.qualifications.default([]),
  experienceYears: Profile.experienceYears.default(null),
  languages: Profile.languages.default(['en']),
  bio: Profile.bio.default(null),
  consultModes: Profile.consultModes.default(['IN_PERSON']),
});
/** No defaults on update: only the fields sent change. */
export const UpdateDoctor = z.object(Profile).partial().extend({ version: z.number().int() });
const SetStatus = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) });
const ListQuery = z.object({ q: z.string().trim().max(80).optional(), status: z.enum(['ACTIVE', 'ANY']).default('ANY'), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

const UNIQUE_VIOLATION = '23505';

/** Hospital staff manage doctors here; patients use the public endpoints. */
@Controller('v1/doctors')
@RequireModule('directory')
export class DoctorsController {
  constructor(private readonly db: TenantDbRouter, private readonly repo: DirectoryRepo, private readonly iam: IamClient, private readonly entitlements: EntitlementsClient) {}

  @Get()
  @RequirePermission('doctor:manage:tenant')
  list(@Query() query: unknown) {
    return this.repo.listDoctors(parse(ListQuery, query));
  }

  @Get(':id')
  @RequirePermission('doctor:manage:tenant')
  async get(@Param('id') id: string) {
    return this.mustFind(id);
  }

  @Post()
  @Idempotent()
  @RequirePermission('doctor:manage:tenant')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const input = parse(CreateDoctor, body);
    const tenantId = TenantContext.require().id;
    const pool = await this.db.current();
    const specialtyIds = await this.resolveSpecialties(pool, input.specialties);
    await this.assertBranches(pool, input.branches.map((b) => b.branchId));
    const dup = await pool.query('SELECT email, registration_no FROM doctors WHERE email = $1 OR registration_no = $2', [input.email, input.registrationNo]);
    if (dup.rows[0]) throw conflict('DOCTOR_EXISTS', dup.rows[0].email === input.email ? 'a doctor with this email already exists' : 'this registration number is already used');
    // the plan's doctor limit (directory.doctors): inactive doctors don't count
    assertWithinLimit(await this.entitlements.capabilities(tenantId, actor), 'directory.doctors', Number((await pool.query(`SELECT count(*) n FROM doctors WHERE status <> 'INACTIVE'`)).rows[0].n));

    // login first (idempotent per email in iam); the profile stays DRAFT until published
    const { userId } = await this.iam.onboardDoctor(tenantId, { email: input.email, name: input.name, invitedBy: actor.id });
    const id = randomUUID();
    try {
      await this.db.tx(async (c) => {
        await c.query(
          `INSERT INTO doctors (id, user_id, email, full_name, gender, registration_no, qualifications, experience_years, languages, bio, consult_modes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, userId, input.email, input.name, input.gender, input.registrationNo, input.qualifications, input.experienceYears, input.languages, input.bio, input.consultModes],
        );
        await this.writeLinks(c, id, specialtyIds, input.branches);
        await this.publish(c, tenantId, EventTypes.doctorCreated, (await this.repo.findDoctor(id, c))!);
      });
    } catch (e) {
      if ((e as any).code === UNIQUE_VIOLATION) throw conflict('DOCTOR_EXISTS', 'a doctor with this email, login or registration number already exists');
      throw e;
    }
    return this.mustFind(id);
  }

  @Patch(':id')
  @RequirePermission('doctor:manage:tenant')
  async update(@Param('id') id: string, @Body() body: unknown) {
    await this.mustFind(id);
    const input = parse(UpdateDoctor, body);
    const tenantId = TenantContext.require().id;
    const pool = await this.db.current();
    const specialtyIds = input.specialties ? await this.resolveSpecialties(pool, input.specialties) : undefined;
    if (input.branches) await this.assertBranches(pool, input.branches.map((b) => b.branchId));
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE doctors SET full_name = coalesce($3, full_name), gender = CASE WHEN $4::boolean THEN $5 ELSE gender END,
           qualifications = coalesce($6, qualifications), experience_years = CASE WHEN $7::boolean THEN $8 ELSE experience_years END,
           languages = coalesce($9, languages), bio = CASE WHEN $10::boolean THEN $11 ELSE bio END, consult_modes = coalesce($12, consult_modes),
           version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $2`,
        [id, input.version, input.name ?? null, 'gender' in input, input.gender ?? null, input.qualifications ?? null,
          'experienceYears' in input, input.experienceYears ?? null, input.languages ?? null, 'bio' in input, input.bio ?? null, input.consultModes ?? null],
      );
      if (!rowCount) throw conflict('VERSION_CONFLICT', 'doctor was changed by someone else; reload and retry');
      if (specialtyIds || input.branches) {
        if (specialtyIds) await c.query('DELETE FROM doctor_specialties WHERE doctor_id = $1', [id]);
        if (input.branches) await c.query('DELETE FROM doctor_branches WHERE doctor_id = $1', [id]);
        await this.writeLinks(c, id, specialtyIds ?? [], input.branches ?? []);
      }
      await this.publish(c, tenantId, EventTypes.doctorUpdated, (await this.repo.findDoctor(id, c))!);
    });
    return this.mustFind(id);
  }

  /** Publish (ACTIVE: visible to patients) or unpublish (INACTIVE). */
  @Post(':id/status')
  @RequirePermission('doctor:manage:tenant')
  async setStatus(@Param('id') id: string, @Body() body: unknown) {
    const doctor = await this.mustFind(id);
    const { status } = parse(SetStatus, body);
    if (status === 'ACTIVE' && (!doctor.branches.length || !doctor.specialties.length)) throw new DomainError(422, 'DOCTOR_INCOMPLETE', 'add at least one specialty and one branch before publishing');
    const tenantId = TenantContext.require().id;
    await this.db.tx(async (c) => {
      await c.query('UPDATE doctors SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, status]);
      await this.publish(c, tenantId, EventTypes.doctorUpdated, (await this.repo.findDoctor(id, c))!);
    });
    return this.mustFind(id);
  }

  /** Re-announce every doctor (rebuilds other services' read models after an event schema change). */
  async republishAll(tenantId: string) {
    const { rows } = await this.db.query('SELECT id FROM doctors');
    await this.db.tx(async (c) => {
      for (const r of rows) await this.publish(c, tenantId, EventTypes.doctorUpdated, (await this.repo.findDoctor(r.id, c))!);
    });
    return { republished: rows.length };
  }

  private async mustFind(id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('doctor');
    return (await this.repo.findDoctor(id)) ?? Promise.reject(notFound('doctor'));
  }

  private async resolveSpecialties(c: Queryable, refs: { code: string; primary: boolean }[]) {
    const { rows } = await c.query('SELECT id, code FROM specialties WHERE active AND code = ANY($1)', [refs.map((r) => r.code)]);
    const byCode = new Map(rows.map((r) => [r.code, r.id]));
    const missing = refs.filter((r) => !byCode.has(r.code)).map((r) => r.code);
    if (missing.length) throw new DomainError(422, 'UNKNOWN_SPECIALTY', `unknown or inactive specialty: ${missing.join(', ')}`);
    const hasPrimary = refs.some((r) => r.primary);
    return refs.map((r, i) => ({ id: byCode.get(r.code)!, primary: hasPrimary ? r.primary : i === 0 }));
  }

  private async assertBranches(c: Queryable, ids: string[]) {
    const { rows } = await c.query('SELECT id FROM branches WHERE active AND id = ANY($1)', [ids]);
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((i) => !found.has(i));
    if (missing.length) throw new DomainError(422, 'UNKNOWN_BRANCH', `unknown or inactive branch: ${missing.join(', ')}`);
  }

  private async writeLinks(c: Queryable, id: string, specialties: { id: string; primary: boolean }[], branches: z.infer<typeof BranchFee>[]) {
    for (const s of specialties) await c.query('INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary) VALUES ($1,$2,$3)', [id, s.id, s.primary]);
    for (const b of branches) await c.query('INSERT INTO doctor_branches (doctor_id, branch_id, consultation_fee, followup_fee) VALUES ($1,$2,$3,$4)', [id, b.branchId, b.fee, b.followupFee ?? null]);
  }

  private async publish(c: Queryable, tenantId: string, type: string, d: DoctorDto) {
    const data: DoctorChanged = { doctorId: d.id, userId: d.userId, name: d.name, status: d.status as DoctorChanged['status'], specialtyCodes: d.specialties.map((s) => s.code), branchIds: d.branches.map((b) => b.id),
      branchFees: d.branches.map((b) => ({ branchId: b.id, fee: b.fee, followupFee: b.followupFee })) };
    await addToOutbox(c, Topics.provider, d.id, envelope(type, data, { tenantId, subject: d.id }));
  }
}
