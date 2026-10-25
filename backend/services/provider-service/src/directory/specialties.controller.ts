import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { conflict, notFound, parse } from '@mc/nest-common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const toCode = (name: string) => name.toUpperCase().replace(/&/g, 'AND').replace(/[^A-Z0-9]+/g, '_').replace(/^[_0-9]+|_$/g, '').slice(0, 40);
export const CreateSpecialty = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).nullable().default(null), code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/).optional() });
export const UpdateSpecialty = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).nullable(), active: z.boolean(), sortOrder: z.number().int().min(0).max(1000) }).partial();
const toDto = (r: any) => ({ id: r.id, code: r.code, name: r.name, description: r.description, active: r.active, sortOrder: r.sort_order, doctorCount: Number(r.doctor_count ?? 0) });

@Controller('v1/specialties')
@RequireModule('directory')
export class SpecialtiesController {
  constructor(private readonly db: TenantDbRouter) {}

  @Get()
  @RequirePermission('doctor:manage:tenant')
  async list() {
    const { rows } = await this.db.query(`SELECT s.*, (SELECT count(*) FROM doctor_specialties ds WHERE ds.specialty_id = s.id) doctor_count FROM specialties s ORDER BY s.sort_order, s.name`);
    return rows.map(toDto);
  }

  @Post()
  @RequirePermission('doctor:manage:tenant')
  async create(@Body() body: unknown) {
    const input = parse(CreateSpecialty, body);
    const code = input.code ?? toCode(input.name);
    const { rows } = await this.db.query(
      `INSERT INTO specialties (id, code, name, description) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING RETURNING *`,
      [randomUUID(), code, input.name, input.description],
    );
    if (!rows[0]) throw conflict('SPECIALTY_EXISTS', `specialty ${code} already exists`);
    return toDto(rows[0]);
  }

  @Patch(':id')
  @RequirePermission('doctor:manage:tenant')
  async update(@Param('id') id: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(id).success) throw notFound('specialty');
    const input = parse(UpdateSpecialty, body);
    const { rows } = await this.db.query(
      `UPDATE specialties SET name = coalesce($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         active = coalesce($5, active), sort_order = coalesce($6, sort_order) WHERE id = $1 RETURNING *`,
      [id, input.name ?? null, 'description' in input, input.description ?? null, input.active ?? null, input.sortOrder ?? null],
    );
    if (!rows[0]) throw notFound('specialty');
    return toDto(rows[0]);
  }
}
