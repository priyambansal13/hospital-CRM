import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import { DomainError, TenantPublic } from '@mc/nest-common';
import { TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { ApiKeysService, type KeyPrincipal } from '../keys/api-keys.service.js';
import { IntegrationAudit } from './audit.js';
import { appointment, bundle, capabilityStatement, diagnosticReport, outcome, patient } from './mappers.js';

const svc = (name: string, port: number) => process.env[`SVC_URL_${name}`] ?? `http://localhost:${port}`;
const isId = (v: string) => z.uuid().safeParse(v).success;
async function internal<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (res?.status === 404) return null;
  if (!res?.ok) throw new DomainError(502, 'UPSTREAM_UNAVAILABLE', 'part of the system is unavailable; try again shortly');
  return (await res.json()) as T;
}
const notFound = (what: string) => new DomainError(404, 'NOT_FOUND', `${what} not found`);

/**
 * HL7 FHIR R4 read API (Phase 27): /api/integration/v1/fhir/r4 on the hospital's address, with an API key (scope
 * fhir:read). Every read is audited as the key. Errors are OperationOutcome resources.
 */
@Controller('v1/fhir/r4')
@TenantPublic()
export class FhirController {
  constructor(private readonly keys: ApiKeysService, private readonly audit: IntegrationAudit) {}

  private base() { return `https://${TenantContext.require().slug}.medicare.app/api/integration/v1/fhir/r4`; }

  /** auth, run, and answer as FHIR (resource or OperationOutcome) */
  private async fhir(reply: any, auth: string | undefined, fn: (k: KeyPrincipal, t: { id: string; slug: string }) => Promise<unknown>) {
    reply.header('content-type', 'application/fhir+json; charset=utf-8');
    try {
      const k = await this.keys.authenticate(auth, 'fhir:read', 'integrations.fhir');
      return await fn(k, TenantContext.require());
    } catch (e) {
      const d = e instanceof DomainError ? e : new DomainError(500, 'INTERNAL', 'unexpected error');
      if (!(e instanceof DomainError)) console.error(e);
      reply.status(d.status);
      return outcome(d.status, d.code, d.message);
    }
  }

  @Get('metadata')
  metadata(@Res({ passthrough: true }) reply: any) {
    reply.header('content-type', 'application/fhir+json; charset=utf-8');
    return capabilityStatement(this.base());
  }

  @Get('Patient/:id')
  readPatient(@Param('id') id: string, @Headers('authorization') auth: string | undefined, @Res({ passthrough: true }) reply: any) {
    return this.fhir(reply, auth, async (k, t) => {
      const p = isId(id) ? await internal<any>(`${svc('PATIENT', 4406)}/internal/tenants/${t.id}/patients/${id}`) : null;
      if (!p) throw notFound('Patient');
      await this.audit.record(k, { action: 'READ', resourceType: 'FHIR_PATIENT', resourceId: p.id, patientId: p.id });
      return patient(t.slug, p);
    });
  }

  @Get('Patient')
  searchPatient(@Query('identifier') identifier: string | undefined, @Headers('authorization') auth: string | undefined, @Res({ passthrough: true }) reply: any) {
    return this.fhir(reply, auth, async (k, t) => {
      const mrn = (identifier ?? '').split('|').pop() ?? '';
      if (!/^MRN\d{1,12}$/i.test(mrn)) throw new DomainError(400, 'SEARCH_PARAM', 'search patients by identifier=<MRN> (e.g. identifier=MRN100023)');
      const p = await internal<any>(`${svc('PATIENT', 4406)}/internal/tenants/${t.id}/patients/by-mrn/${encodeURIComponent(mrn)}`);
      if (p) await this.audit.record(k, { action: 'READ', resourceType: 'FHIR_PATIENT', resourceId: p.id, patientId: p.id });
      return bundle(this.base(), p ? [patient(t.slug, p)] : []);
    });
  }

  @Get('Appointment/:id')
  readAppointment(@Param('id') id: string, @Headers('authorization') auth: string | undefined, @Res({ passthrough: true }) reply: any) {
    return this.fhir(reply, auth, async (k, t) => {
      const a = isId(id) ? await internal<any>(`${svc('SCHEDULING', 4405)}/internal/tenants/${t.id}/appointments/by-id/${id}`) : null;
      if (!a) throw notFound('Appointment');
      await this.audit.record(k, { action: 'READ', resourceType: 'FHIR_APPOINTMENT', resourceId: a.id, patientId: a.patient.id });
      return appointment(t.slug, a);
    });
  }

  @Get('Appointment')
  searchAppointment(@Query('patient') pRef: string | undefined, @Headers('authorization') auth: string | undefined, @Res({ passthrough: true }) reply: any) {
    return this.fhir(reply, auth, async (k, t) => {
      const pid = (pRef ?? '').replace(/^Patient\//, '');
      if (!isId(pid)) throw new DomainError(400, 'SEARCH_PARAM', 'search appointments by patient=<Patient id>');
      const list = (await internal<any[]>(`${svc('SCHEDULING', 4405)}/internal/tenants/${t.id}/appointments/of-patient/${pid}`)) ?? [];
      if (list.length) await this.audit.record(k, { action: 'READ', resourceType: 'FHIR_APPOINTMENT', patientId: pid, changes: [`${list.length} appointments`] });
      return bundle(this.base(), list.map((a) => appointment(t.slug, a)));
    });
  }

  @Get('DiagnosticReport')
  searchReports(@Query('patient') pRef: string | undefined, @Headers('authorization') auth: string | undefined, @Res({ passthrough: true }) reply: any) {
    return this.fhir(reply, auth, async (k, t) => {
      const pid = (pRef ?? '').replace(/^Patient\//, '');
      if (!isId(pid)) throw new DomainError(400, 'SEARCH_PARAM', 'search reports by patient=<Patient id>');
      const sheets = (await internal<any[]>(`${svc('DIAGNOSTICS', 4412)}/internal/tenants/${t.id}/patients/${pid}/lab-reports`)) ?? [];
      if (sheets.length) await this.audit.record(k, { action: 'READ', resourceType: 'FHIR_DIAGNOSTIC_REPORT', patientId: pid, changes: sheets.map((s) => s.order.orderNo) });
      return bundle(this.base(), sheets.map((s) => diagnosticReport(t.slug, s)));
    });
  }
}
