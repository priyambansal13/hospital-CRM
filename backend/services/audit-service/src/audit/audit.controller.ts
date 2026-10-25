import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { AuditEntry } from '@mc/contracts';
import { CurrentActor, DomainError, forbidden, Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { AuditService, toEntry } from './audit.service.js';

const Batch = z.object({ source: z.string().min(3).max(40), entries: z.array(AuditEntry).min(1).max(100) });
const Filter = z.object({
  patientId: z.uuid().optional(), actorId: z.string().max(64).optional(), action: z.string().max(20).optional(),
  purpose: z.string().max(20).optional(), before: z.coerce.number().int().positive().optional(),
});

/** Admin: the hospital's audit log, and a tamper check of the whole chain. */
@Controller('v1/audit')
@RequirePermission('audit:read:tenant')
export class AuditController {
  constructor(private readonly db: TenantDbRouter, private readonly audit: AuditService) {}

  @Get()
  async list(@Query() query: unknown) {
    const f = parse(Filter, query);
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    if (f.patientId) add('patient_id = ?', f.patientId);
    if (f.actorId) add('actor_id = ?', f.actorId);
    if (f.action) add('action = ?', f.action);
    if (f.purpose) add('purpose = ?', f.purpose);
    if (f.before) add('id < ?', f.before);
    const { rows } = await this.db.query(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 100`, args);
    const { rows: [bg] } = await this.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'BREAK_GLASS' AND occurred_at > now() - interval '7 days'`);
    return { items: rows.map(toEntry), nextBefore: rows.length === 100 ? Number(rows.at(-1).id) : null, breakGlassLast7Days: bg.n };
  }

  @Get('verify')
  async verify() {
    return this.audit.verify(await this.db.current());
  }
}

/** Patients: who opened their (or their family member's) record — staff access only, not their own reads. */
@Controller('v1/me/access-log')
export class AccessLogController {
  constructor(private readonly db: TenantDbRouter) {}

  @Get()
  @RequirePermission('audit:read:own')
  async mine(@Query('patientId') patientId: string | undefined, @CurrentActor() actor: Actor) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'patients only');
    if (!z.uuid().safeParse(patientId ?? '').success) throw new DomainError(400, 'PATIENT_REQUIRED', 'choose whose record');
    await assertPatientAccess(TenantContext.require().id, patientId!, actor.id);
    const { rows } = await this.db.query(
      `SELECT * FROM audit_log WHERE patient_id = $1 AND actor_kind = 'staff' AND action <> 'DENIED' ORDER BY id DESC LIMIT 200`, [patientId]);
    return rows.map((r) => ({ id: String(r.id), occurredAt: r.occurred_at, who: r.actor_name ?? 'Hospital staff', action: r.action, what: r.resource_type, purpose: r.purpose }));
  }
}

async function assertPatientAccess(tenantId: string, patientId: string, personId: string) {
  const res = await fetch(`${process.env.SVC_URL_PATIENT ?? 'http://localhost:4406'}/internal/tenants/${tenantId}/patients/${patientId}/access/${personId}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' } });
  if (res.status === 404) throw notFound('patient');
  if (!res.ok) throw new DomainError(502, 'PATIENTS_UNAVAILABLE', `patient-service ${res.status}`);
}

/** Service-to-service: append entries (records-service writes before it returns patient data). */
@Controller('internal/tenants/:tenantId/audit')
export class InternalAuditController {
  constructor(private readonly audit: AuditService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post()
  @Internal()
  async append(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    const b = parse(Batch, body);
    return TenantContext.run(await this.placements.get(tenantId), async () => ({ ids: await this.audit.append(b.source, b.entries) }));
  }
}
