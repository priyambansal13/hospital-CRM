import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { CurrentActor, forbidden, Internal, notFound, PLACEMENTS } from '@mc/nest-common';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { RecordAccess } from './access.js';

const uuid = (v: string | undefined, what: string) => { if (!z.uuid().safeParse(v ?? '').success) throw notFound(what); return v!; };

/** Scheduling asks before a visit is completed: is its note signed? (docs/ROLE-FLOWS-AND-GAPS.md C-4) No clinical text. */
@Controller('internal/tenants/:tenantId/encounters')
export class InternalEncounterStatusController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get('status')
  @Internal()
  async status(@Param('tenantId') t: string, @Query('appointmentId') appointmentId: string) {
    uuid(t, 'tenant');
    uuid(appointmentId, 'appointment');
    return TenantContext.run(await this.placements.get(t), async () => {
      const { rows: [e] } = await this.db.query('SELECT id, status FROM encounters WHERE appointment_id = $1', [appointmentId]);
      return { encounterId: e?.id ?? null, status: (e?.status as string | undefined) ?? null };
    });
  }
}

/** The doctor's notes still to sign: finished (or deferred) visits must not be forgotten. Names and dates only. */
@Controller('v1/encounters')
@RequireModule('emr')
export class UnsignedEncountersController {
  constructor(private readonly db: TenantDbRouter, private readonly access: RecordAccess) {}

  @Get('unsigned')
  @RequirePermission('record:write:treating')
  async unsigned(@CurrentActor() actor: Actor) {
    const c = await this.db.current();
    const doctor = await this.access.doctorOf(c, actor);
    if (!doctor) throw forbidden('DOCTORS_ONLY', 'only doctors write visit notes');
    const { rows } = await c.query(
      `SELECT e.id, e.appointment_id, e.started_at, p.name AS patient_name, p.mrn
       FROM encounters e JOIN patients p ON p.id = e.patient_id
       WHERE e.doctor_id = $1 AND e.status = 'OPEN' ORDER BY e.started_at LIMIT 50`, [doctor.id]);
    return rows.map((r) => ({ encounterId: r.id, appointmentId: r.appointment_id, startedAt: r.started_at, patient: { name: r.patient_name, mrn: r.mrn } }));
  }
}
