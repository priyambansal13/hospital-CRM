import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { CONTROL_DB, CurrentActor, Idempotent, notFound, parse } from '@mc/nest-common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, TenantContext } from '@mc/tenancy';
import type pg from 'pg';
import { z } from 'zod';
import { prescriptionPdf } from './prescription-pdf.js';
import { RecordsService } from './records.service.js';
import { Vitals } from './vitals.js';

const Uuid = z.uuid();
const id = (v: string, what: string) => { if (!Uuid.safeParse(v ?? '').success) throw notFound(what); return v; };
const text = (max: number) => z.string().trim().max(max).nullable();
const Diagnosis = z.object({ code: z.string().trim().regex(/^[A-Z]\d{2}(\.\d{1,2})?$/, 'ICD-10 code like E11.9').nullable().optional(), description: text(200).optional(), isPrimary: z.boolean().optional() });
const Update = z.object({ version: z.number().int(), vitals: Vitals.optional(), chiefComplaint: text(500).optional(), notes: text(10_000).optional(), diagnoses: z.array(Diagnosis).max(10).optional() });
const Amend = z.object({ reason: z.string().trim().min(5).max(300), chiefComplaint: text(500).optional(), notes: text(10_000).optional(), diagnoses: z.array(Diagnosis).max(10).optional() });
const Item = z.object({
  drugName: z.string().trim().min(2).max(150), strength: text(40).optional(), form: text(30).optional(),
  dosage: z.string().trim().min(1).max(40), durationDays: z.number().int().min(1).max(365).nullable().optional(), instructions: text(200).optional(),
});
const Prescribe = z.object({ items: z.array(Item).min(1).max(20), advice: text(2000).optional(), followUpOn: z.iso.date().nullable().optional(), allergyOverride: z.string().trim().min(5, 'say why (at least 5 characters)').max(300).nullable().optional() });
const BreakGlass = z.object({ reason: z.string().trim().min(10, 'say why (at least 10 characters)').max(300) });

/** Clinical records (docs/LLD.md §6.6). Coarse permission on the route; the treating-relationship policy inside. */
@Controller('v1')
@RequireModule('emr')
export class RecordsController {
  constructor(private readonly records: RecordsService, @Inject(CONTROL_DB) private readonly control: pg.Pool) {}

  @Get('icd10')
  @RequirePermission('record:write:treating')
  async icd(@Query('q') q: string | undefined) {
    const term = (q ?? '').trim();
    if (term.length < 2) return [];
    const { rows } = await this.control.query(
      `SELECT code, title FROM icd10_codes WHERE code ILIKE $1 || '%' OR lower(title) LIKE '%' || lower($1) || '%'
       ORDER BY (code ILIKE $1 || '%') DESC, length(code), code LIMIT 15`, [term.replace(/[%_\\]/g, '')]);
    return rows;
  }

  @Post('encounters')
  @RequirePermission('record:write:treating')
  open(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.records.openForAppointment(actor, parse(z.object({ appointmentId: z.uuid() }), body).appointmentId);
  }

  @Get('encounters/by-appointment/:appointmentId')
  @RequirePermission('record:read:treating')
  byAppointment(@Param('appointmentId') a: string, @CurrentActor() actor: Actor) {
    return this.records.byAppointment(actor, id(a, 'encounter'));
  }

  @Get('encounters/:id')
  @RequirePermission('record:read:treating')
  get(@Param('id') e: string, @CurrentActor() actor: Actor) {
    return this.records.getEncounter(actor, id(e, 'encounter'));
  }

  @Patch('encounters/:id')
  @RequirePermission('record:write:treating')
  update(@Param('id') e: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.records.update(actor, id(e, 'encounter'), parse(Update, body));
  }

  @Post('encounters/:id/sign')
  @HttpCode(200)
  @RequirePermission('record:write:treating')
  sign(@Param('id') e: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.records.sign(actor, id(e, 'encounter'), parse(z.object({ version: z.number().int() }), body).version);
  }

  @Post('encounters/:id/amendments')
  @RequirePermission('record:write:treating')
  amend(@Param('id') e: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.records.amend(actor, id(e, 'encounter'), parse(Amend, body));
  }

  @Post('encounters/:id/prescriptions')
  @Idempotent()
  @RequirePermission('record:write:treating')
  prescribe(@Param('id') e: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.records.prescribe(actor, id(e, 'encounter'), parse(Prescribe, body));
  }

  /** Doctor or the patient's own account (policy decides; both audited). */
  @Get('prescriptions/:id')
  getRx(@Param('id') p: string, @CurrentActor() actor: Actor) {
    return this.records.getPrescription(actor, id(p, 'prescription'));
  }

  @Get('prescriptions/:id/pdf')
  async pdf(@Param('id') p: string, @CurrentActor() actor: Actor, @Res({ passthrough: true }) reply: any) {
    const rx = await this.records.getPrescription(actor, id(p, 'prescription'), 'EXPORT');
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${rx.prescriptionNo}.pdf"`).header('cache-control', 'private, no-store');
    return prescriptionPdf(TenantContext.require().name, rx);
  }

  @Get('me/prescriptions')
  @RequirePermission('record:read:own')
  mine(@CurrentActor() actor: Actor) {
    return this.records.myPrescriptions(actor);
  }

  @Get('patients/lookup')
  @RequirePermission('record:read:treating')
  lookup(@Query('mrn') mrn: string | undefined, @CurrentActor() actor: Actor) {
    return this.records.lookup(actor, parse(z.string().trim().regex(/^MRN\d+$/i, 'enter an MRN like MRN100023'), mrn ?? ''));
  }

  @Get('patients/:patientId/chart')
  @RequirePermission('record:read:treating')
  chart(@Param('patientId') p: string, @CurrentActor() actor: Actor) {
    return this.records.chart(actor, id(p, 'patient'));
  }

  @Post('patients/:patientId/break-glass')
  @RequirePermission('record:break_glass:tenant')
  breakGlass(@Param('patientId') p: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.records.breakGlass(actor, id(p, 'patient'), parse(BreakGlass, body).reason);
  }
}
