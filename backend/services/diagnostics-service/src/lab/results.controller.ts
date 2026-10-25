import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { CurrentActor, notFound, parse, TenantPublic } from '@mc/nest-common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import type { Actor } from '@mc/tenancy';
import { z } from 'zod';
import { LabService } from './lab.service.js';
import { ResultsService } from './results.service.js';

const Uuid = z.uuid();
const id = (v: string, what: string) => { if (!Uuid.safeParse(v ?? '').success) throw notFound(what); return v; };
const Entries = z.array(z.object({ itemId: z.uuid(), parameter: z.string().min(1).max(80), value: z.string().max(120) })).min(1).max(200);
const Enter = z.object({ results: Entries });
const Amend = z.object({ reason: z.string().trim().min(5).max(300), results: Entries });
const sendPdf = (reply: any, r: { pdf: Buffer; name: string }) => {
  reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${r.name}"`).header('cache-control', 'private, no-store');
  return r.pdf;
};

/** Lab bench: results, verification, amendments, the report PDF, critical values of self-booked tests. */
@Controller('v1/lab')
@RequireModule('diagnostics')
export class LabResultsController {
  constructor(private readonly results: ResultsService, private readonly lab: LabService) {}

  @Get('pending')
  @RequirePermission('lab_order:read:branch')
  pending(@Query('branchId') b: string, @CurrentActor() actor: Actor) {
    return this.lab.pending(actor, id(b, 'branch'));
  }

  @Get('orders/:id/results')
  @RequirePermission('lab_order:read:branch')
  sheet(@Param('id') o: string, @CurrentActor() actor: Actor) {
    return this.results.getSheet(actor, id(o, 'lab order'));
  }

  @Post('orders/:id/results')
  @HttpCode(200)
  @RequirePermission('result:enter:branch')
  enter(@Param('id') o: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.results.enter(actor, id(o, 'lab order'), parse(Enter, body).results);
  }

  @Post('orders/:id/verify')
  @RequirePermission('report:verify:branch')
  verify(@Param('id') o: string, @CurrentActor() actor: Actor) {
    return this.results.verify(actor, id(o, 'lab order'));
  }

  @Post('orders/:id/amend')
  @RequirePermission('report:verify:branch')
  amend(@Param('id') o: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const v = parse(Amend, body);
    return this.results.amend(actor, id(o, 'lab order'), v.reason, v.results);
  }

  @Get('orders/:id/report.pdf')
  @RequirePermission('lab_order:read:branch')
  async pdf(@Param('id') o: string, @CurrentActor() actor: Actor, @Res({ passthrough: true }) reply: any) {
    return sendPdf(reply, await this.results.pdf(actor, id(o, 'lab order'), true));
  }

  @Get('critical-alerts')
  @RequirePermission('report:verify:branch')
  alerts(@CurrentActor() actor: Actor) {
    return this.results.alerts(actor, true);
  }

  @Post('critical-alerts/:id/ack')
  @HttpCode(200)
  @RequirePermission('report:verify:branch')
  ack(@Param('id') a: string, @CurrentActor() actor: Actor) {
    return this.results.acknowledge(actor, id(a, 'alert'), true);
  }
}

/** Doctors: tests they ordered, results, critical values to acknowledge. Patients: their verified results and PDF. */
@Controller('v1')
@RequireModule('diagnostics')
export class ResultsAccessController {
  constructor(private readonly results: ResultsService) {}

  @Get('doctor/lab-orders')
  @RequirePermission('lab_order:read:treating')
  ordered(@CurrentActor() actor: Actor) {
    return this.results.ordered(actor);
  }

  @Get('doctor/lab-orders/:id/results')
  @RequirePermission('lab_order:read:treating')
  doctorResults(@Param('id') o: string, @CurrentActor() actor: Actor) {
    return this.results.resultsForDoctor(actor, id(o, 'lab order'));
  }

  @Get('doctor/critical-alerts')
  @RequirePermission('lab_order:read:treating')
  doctorAlerts(@CurrentActor() actor: Actor) {
    return this.results.alerts(actor, false);
  }

  @Post('doctor/critical-alerts/:id/ack')
  @HttpCode(200)
  @RequirePermission('lab_order:read:treating')
  doctorAck(@Param('id') a: string, @CurrentActor() actor: Actor) {
    return this.results.acknowledge(actor, id(a, 'alert'), false);
  }

  @Get('lab-orders/:id/results')
  @RequirePermission('lab_order:read:own')
  mine(@Param('id') o: string, @CurrentActor() actor: Actor) {
    return this.results.resultsForPatient(actor, id(o, 'lab order'));
  }

  /** Patient (own) or a doctor with access. */
  @Get('lab-orders/:id/report.pdf')
  async pdf(@Param('id') o: string, @CurrentActor() actor: Actor, @Res({ passthrough: true }) reply: any) {
    return sendPdf(reply, await this.results.pdf(actor, id(o, 'lab order'), false));
  }

  /** Behind the QR code on every report. */
  @Get('public/lab-reports/verify/:code')
  @TenantPublic()
  verifyCode(@Param('code') code: string) {
    return this.results.verifyCode(parse(z.string().trim().regex(/^[A-Z0-9]{6,12}$/i), code));
  }
}
