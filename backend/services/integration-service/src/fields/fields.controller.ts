import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { FieldDef, FieldKey } from '@mc/contracts';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { type Entity, FieldsService } from './fields.service.js';

const id = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };
const EntityQ = z.enum(['PATIENT', 'APPOINTMENT']).optional();
// zod .partial() keeps defaults, so the patch schemas are written out without them
const NewField = z.object({
  entity: z.enum(['PATIENT', 'APPOINTMENT']), key: FieldKey, label: z.string().trim().min(1).max(80), type: z.enum(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN']),
  options: z.array(z.string().trim().min(1).max(60)).max(30).default([]), required: z.boolean().default(false), help: z.string().trim().max(200).nullable().default(null),
  sort: z.number().int().min(0).max(1000).default(0),
}).refine((f) => f.type !== 'SELECT' || f.options.length >= 2, { message: 'a choice field needs at least two options', path: ['options'] });
const FieldPatch = z.object({
  label: z.string().trim().min(1).max(80).optional(), options: z.array(z.string().trim().min(1).max(60)).max(30).optional(), required: z.boolean().optional(),
  help: z.string().trim().max(200).nullable().optional(), active: z.boolean().optional(), sort: z.number().int().min(0).max(1000).optional(), version: z.number().int(),
});
const Questions = z.array(FieldDef).min(1).max(25);
const NewForm = z.object({
  name: z.string().trim().min(2).max(80), specialtyCode: z.string().trim().toUpperCase().max(40).nullable().default(null),
  intro: z.string().trim().max(500).nullable().default(null), fields: Questions,
});
const FormPatch = z.object({ name: z.string().trim().min(2).max(80).optional(), intro: z.string().trim().max(500).nullable().optional(), fields: Questions.optional(), active: z.boolean().optional(), version: z.number().int() });

/** Admin: the hospital's custom fields and forms. */
@Controller('v1')
@RequireModule('workflows')
@RequirePermission('customization:manage:tenant')
export class FieldsAdminController {
  constructor(private readonly f: FieldsService) {}
  @Get('custom-fields') list(@Query('entity') e?: string) { return this.f.fields(parse(EntityQ, e) as Entity | undefined); }
  @Post('custom-fields') create(@Body() body: unknown) { return this.f.createField(parse(NewField, body)); }
  @Patch('custom-fields/:id') update(@Param('id') p: string, @Body() body: unknown) { return this.f.updateField(id(p, 'custom field'), parse(FieldPatch, body)); }
  @Get('forms') forms() { return this.f.forms(false); }
  @Post('forms') createForm(@Body() body: unknown) { return this.f.createForm(parse(NewForm, body)); }
  @Patch('forms/:id') updateForm(@Param('id') p: string, @Body() body: unknown) { return this.f.updateForm(id(p, 'form'), parse(FormPatch, body)); }
}

/** Staff who fill the fields in (desk, nurses) read the active definitions. */
@Controller('v1')
@RequireModule('workflows')
@RequirePermission('custom_field:write:branch')
export class FieldsReadController {
  constructor(private readonly f: FieldsService) {}
  @Get('custom-fields/active') active(@Query('entity') e?: string) { return this.f.fields(parse(EntityQ, e) as Entity | undefined, true); }
}

/** patient-service and scheduling-service validate values; scheduling picks the form for a visit. */
@Controller('internal/tenants/:tenantId')
export class InternalFieldsController {
  constructor(private readonly f: FieldsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}
  private async run<T>(t: string, fn: () => Promise<T>) { return TenantContext.run(await this.placements.get(id(t, 'tenant')), fn); }

  @Get('custom-fields')
  @Internal()
  fields(@Param('tenantId') t: string, @Query('entity') e?: string) { return this.run(t, () => this.f.fields(parse(EntityQ, e) as Entity | undefined, true)); }

  @Get('forms/for-visit')
  @Internal()
  formFor(@Param('tenantId') t: string, @Query('specialties') s?: string) { return this.run(t, async () => ({ form: await this.f.formFor((s ?? '').split(',').filter(Boolean)) })); }

  @Get('forms/:formId')
  @Internal()
  form(@Param('tenantId') t: string, @Param('formId') f: string) { return this.run(t, () => this.f.form(id(f, 'form'))); }
}
