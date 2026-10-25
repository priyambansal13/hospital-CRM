import { Controller, Get, Param, Query } from '@nestjs/common';
import { notFound, parse, TenantPublic } from '@mc/nest-common';
import { RequireModule } from '@mc/entitlements-sdk';
import { TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { DirectoryRepo, toPublicDoctor } from './directory.repo.js';

const Search = z.object({
  q: z.string().trim().max(80).optional(),
  specialty: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/).optional(),
  branch: z.uuid().optional(),
  language: z.string().regex(/^[a-z]{2,3}$/).optional(),
  gender: z.enum(['FEMALE', 'MALE', 'OTHER']).optional(),
  mode: z.enum(['IN_PERSON', 'VIDEO']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * What patients browse before (or after) signing in. Only published (ACTIVE) doctors, only active specialties and
 * branches, no staff-only fields. The hospital comes from the host; the directory module must be active.
 */
@Controller('v1/public')
@RequireModule('directory')
export class PublicDirectoryController {
  constructor(private readonly db: TenantDbRouter, private readonly repo: DirectoryRepo) {}

  @Get('specialties')
  @TenantPublic()
  async specialties() {
    const { rows } = await this.db.query(
      `SELECT s.code, s.name, s.description,
              (SELECT count(*) FROM doctor_specialties ds JOIN doctors d ON d.id = ds.doctor_id WHERE ds.specialty_id = s.id AND d.status = 'ACTIVE') AS doctors
       FROM specialties s WHERE s.active ORDER BY s.sort_order, s.name`,
    );
    return rows.map((r) => ({ code: r.code, name: r.name, description: r.description, doctorCount: Number(r.doctors) }));
  }

  @Get('branches')
  @TenantPublic()
  async branches() {
    const { rows } = await this.db.query('SELECT id, name FROM branches WHERE active ORDER BY name');
    return rows;
  }

  @Get('doctors')
  @TenantPublic()
  async doctors(@Query() query: unknown) {
    const f = parse(Search, query);
    const { items, nextCursor } = await this.repo.listDoctors({ ...f, branchId: f.branch, status: 'ACTIVE' });
    return { items: items.map(toPublicDoctor), nextCursor };
  }

  @Get('doctors/:id')
  @TenantPublic()
  async doctor(@Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('doctor');
    const d = await this.repo.findDoctor(id);
    if (!d || d.status !== 'ACTIVE') throw notFound('doctor');
    return toPublicDoctor(d);
  }
}
