import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { branchesFor, EntitlementsClient } from '@mc/entitlements-sdk';
import { checkValues } from '@mc/contracts';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { conflict, CurrentActor, CustomFieldsClient, DomainError, forbidden, Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { APPT_SELECT, AppointmentsService, toStaffAppointment } from './appointments.service.js';

const id = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };
const Values = z.object({ values: z.record(z.string(), z.unknown()), version: z.number().int() });
/** answers can be given or changed until the visit starts */
const OPEN_FOR_ANSWERS = ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'];

/**
 * Phase 27 on appointments: the hospital's custom fields (desk, nurses, the doctor) and the pre-visit form the patient
 * fills in (the doctor's specialty's form, else the one for every visit). Answers are stored with a copy of the
 * questions, so a later change to the form never changes what the patient answered.
 */
@Controller('v1/appointments')
@RequireModule('workflows')
export class AppointmentCustomController {
  constructor(private readonly db: TenantDbRouter, private readonly svc: AppointmentsService, private readonly fields: CustomFieldsClient, private readonly entitlements: EntitlementsClient) {}

  /** A patient's recent and coming appointments at the person's branches (desk: fill in appointment fields). */
  @Get('of-patient/:patientId')
  @RequirePermission('custom_field:write:branch')
  async ofPatient(@Param('patientId') p: string, @CurrentActor() actor: Actor) {
    const branches = branchesFor(await this.entitlements.capabilities(TenantContext.require().id, actor), 'custom_field:write:branch');
    const { rows } = await this.db.query(
      `${APPT_SELECT} WHERE a.patient_id = $1 AND ($2::uuid[] IS NULL OR a.branch_id = ANY($2)) AND a.starts_at > now() - interval '30 days'
         AND a.status NOT IN ('EXPIRED','RESCHEDULED') ORDER BY a.starts_at DESC LIMIT 20`, [id(p, 'patient'), branches]);
    return rows.map(toStaffAppointment);
  }

  @Put(':id/custom-fields')
  @RequirePermission('custom_field:write:branch')
  async saveFields(@Param('id') apptId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const { values, version } = parse(Values, body);
    const tenant = TenantContext.require();
    return this.db.tx(async (c) => {
      const { row, as } = await this.svc.assertAccess(c, actor, id(apptId, 'appointment'), 'custom_field:write:branch');
      if (as === 'patient') throw notFound('appointment');
      const { rows: [cur] } = await c.query('SELECT custom_fields, version FROM appointments WHERE id = $1 FOR UPDATE', [row.id]);
      if (cur.version !== version) throw conflict('VERSION_CONFLICT', 'this appointment changed in another window; reload');
      const next = await this.fields.merge(tenant.id, 'APPOINTMENT', cur.custom_fields ?? {}, values);
      await c.query('UPDATE appointments SET custom_fields = $2, version = version + 1, updated_at = now() WHERE id = $1', [row.id, JSON.stringify(next)]);
      return toStaffAppointment(await this.svc.find(c, row.id));
    });
  }

  /** The form for this visit (null: the hospital has none) and the answers so far. */
  @Get(':id/form')
  async form(@Param('id') apptId: string, @CurrentActor() actor: Actor) {
    const { row } = await this.svc.assertAccess(await this.db.current(), actor, id(apptId, 'appointment'), 'appointment:read:branch');
    const answered = row.form_answers as { formId: string } | null;
    const form = answered ? null : await this.fields.formFor(TenantContext.require().id, row.doctor_specialties ?? []);
    return { form, answers: answered, canAnswer: actor.kind === 'patient' && OPEN_FOR_ANSWERS.includes(row.status) };
  }

  @Put(':id/form')
  @RequirePermission('form:submit:own')
  async answer(@Param('id') apptId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'the patient fills in this form');
    const { answers } = parse(z.object({ answers: z.record(z.string(), z.unknown()) }), body);
    const tenant = TenantContext.require();
    return this.db.tx(async (c) => {
      const { row } = await this.svc.assertAccess(c, actor, id(apptId, 'appointment'), 'appointment:read:branch');
      if (!OPEN_FOR_ANSWERS.includes(row.status)) throw new DomainError(422, 'FORM_CLOSED', 'the visit has started or ended; tell the doctor instead');
      const prev = row.form_answers as { formId: string } | null;
      const form = prev ? await this.fields.form(tenant.id, prev.formId) : await this.fields.formFor(tenant.id, row.doctor_specialties ?? []);
      if (!form) throw notFound('form');
      const r = checkValues(form.fields, answers);
      if (!r.ok) throw new DomainError(400, 'VALIDATION_FAILED', 'some answers are not valid', { errors: r.errors });
      const stored = { formId: form.id, formName: form.name, formVersion: form.version, fields: form.fields, answers: r.values, submittedAt: new Date().toISOString() };
      await c.query('UPDATE appointments SET form_answers = $2, version = version + 1, updated_at = now() WHERE id = $1', [row.id, JSON.stringify(stored)]);
      return { answers: stored };
    });
  }
}

/** Workflow rules (integration-service) ask that a patient pays online when booking, or lift it. */
@Controller('internal/tenants/:tenantId/patients/:patientId/prepayment')
export class InternalPrepaymentController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post()
  @Internal()
  @HttpCode(200)
  async set(@Param('tenantId') t: string, @Param('patientId') p: string, @Body() body: unknown) {
    const v = parse(z.object({ required: z.boolean(), reason: z.string().trim().max(200).nullable().default(null), ruleId: z.uuid().nullable().default(null) }), body);
    return TenantContext.run(await this.placements.get(id(t, 'tenant')), async () => {
      await this.db.query(
        `INSERT INTO patient_flags (patient_id, prepay_required, reason, set_by_rule) VALUES ($1,$2,$3,$4)
         ON CONFLICT (patient_id) DO UPDATE SET prepay_required = $2, reason = $3, set_by_rule = $4, updated_at = now()`, [id(p, 'patient'), v.required, v.reason, v.ruleId]);
      return { patientId: p, prepayRequired: v.required };
    });
  }

  @Get()
  @Internal()
  async get(@Param('tenantId') t: string, @Param('patientId') p: string) {
    return TenantContext.run(await this.placements.get(id(t, 'tenant')), async () => {
      const { rows: [f] } = await this.db.query('SELECT prepay_required, reason FROM patient_flags WHERE patient_id = $1', [id(p, 'patient')]);
      return { patientId: p, prepayRequired: !!f?.prepay_required, reason: f?.reason ?? null };
    });
  }
}

/** integration-service's FHIR API (Phase 27): an appointment, or a patient's appointments (newest first). */
@Controller('internal/tenants/:tenantId/appointments')
export class InternalAppointmentReadController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get('by-id/:id')
  @Internal()
  async one(@Param('tenantId') t: string, @Param('id') a: string) {
    return TenantContext.run(await this.placements.get(id(t, 'tenant')), async () => {
      const { rows: [r] } = await this.db.query(`${APPT_SELECT} WHERE a.id = $1`, [id(a, 'appointment')]);
      if (!r) throw notFound('appointment');
      return toStaffAppointment(r);
    });
  }

  @Get('of-patient/:patientId')
  @Internal()
  async ofPatient(@Param('tenantId') t: string, @Param('patientId') p: string) {
    return TenantContext.run(await this.placements.get(id(t, 'tenant')), async () => {
      const { rows } = await this.db.query(`${APPT_SELECT} WHERE a.patient_id = $1 ORDER BY a.starts_at DESC LIMIT 100`, [id(p, 'patient')]);
      return rows.map(toStaffAppointment);
    });
  }
}
