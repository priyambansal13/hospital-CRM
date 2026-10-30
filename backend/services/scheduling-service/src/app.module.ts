import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { BranchChanged, DoctorChanged, EventTypes, PaymentSucceeded, RefundProcessed, Topics } from '@mc/contracts';
import { ConsumerRegistry, CoreModule } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import type { Queryable } from '@mc/tenancy';
import { AppointmentsController, InternalAppointmentsController, InternalNextSlotsController } from './schedule/appointments.controller.js';
import { AppointmentsService } from './schedule/appointments.service.js';
import { BillingClient } from './schedule/billing.client.js';
import { HoldExpiryJob } from './schedule/hold-expiry.job.js';
import { HorizonJob } from './schedule/horizon.job.js';
import { NoShowJob } from './schedule/no-show.job.js';
import { AgendaJob, InternalAgendaController } from './schedule/agenda.job.js';
import { PatientsClient } from './schedule/patients.client.js';
import { DeskController, InternalQueueController, QueueController } from './schedule/queue.controller.js';
import { QueueService } from './schedule/queue.service.js';
import { ScheduleController, UpcomingAppointmentsController } from './schedule/schedule.controller.js';
import { ScheduleService } from './schedule/schedule.service.js';

async function upsertBranch(c: Queryable, data: unknown, appts: AppointmentsService) {
  const b = BranchChanged.parse(data);
  await c.query(`INSERT INTO branches (id, name, timezone, active) VALUES ($1,$2,$3,$4)
    ON CONFLICT (id) DO UPDATE SET name = $2, timezone = $3, active = $4, updated_at = now()`, [b.branchId, b.name, b.timezone, b.active]);
  // a closed branch: its future bookings are cancelled, refunded and patients told (review D-5)
  if (!b.active) await appts.cancelUnavailable(c, { branchId: b.branchId });
}

/** Doctor read model; when a doctor stops practising at a branch, their hours there (and open slots) go. */
async function upsertDoctor(c: Queryable, data: unknown, svc: ScheduleService, appts: AppointmentsService) {
  const d = DoctorChanged.parse(data);
  await c.query(`INSERT INTO doctors (id, user_id, name, status, branch_ids, branch_fees) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO UPDATE SET user_id = $2, name = $3, status = $4, branch_ids = $5,
      branch_fees = CASE WHEN $6::jsonb = '[]'::jsonb THEN doctors.branch_fees ELSE $6::jsonb END, updated_at = now()`,
    [d.doctorId, d.userId, d.name, d.status, d.branchIds, JSON.stringify(d.branchFees)]);
  const { rows } = await c.query('SELECT id FROM availability_templates WHERE doctor_id = $1 AND NOT (branch_id = ANY($2))', [d.doctorId, d.branchIds]);
  for (const r of rows) await svc.removeHours(c, d.doctorId, r.id);
  // unpublished: every future booking goes; no longer at a branch: the bookings there go (review D-5)
  if (d.status === 'INACTIVE') await appts.cancelUnavailable(c, { doctorId: d.doctorId });
  // (an empty branch list never mass-cancels: a malformed or legacy event must not wipe an active doctor's day)
  else if (d.branchIds.length) await appts.cancelUnavailable(c, { doctorId: d.doctorId, notAtBranches: d.branchIds });
}

@Injectable()
class SchedulingConsumers implements OnModuleInit {
  constructor(private readonly registry: ConsumerRegistry, private readonly svc: ScheduleService, private readonly appts: AppointmentsService) {}
  onModuleInit() {
    this.registry.register({
      group: 'scheduling.branches',
      topics: [Topics.tenant],
      handlers: {
        [EventTypes.branchCreated]: (e, db) => upsertBranch(db!, e.data, this.appts),
        [EventTypes.branchUpdated]: (e, db) => upsertBranch(db!, e.data, this.appts),
      },
    });
    this.registry.register({
      group: 'scheduling.doctors',
      topics: [Topics.provider],
      handlers: {
        [EventTypes.doctorCreated]: (e, db) => upsertDoctor(db!, e.data, this.svc, this.appts),
        [EventTypes.doctorUpdated]: (e, db) => upsertDoctor(db!, e.data, this.svc, this.appts),
      },
    });
    // payment saga (docs/LLD.md §5.3): billing tells us when an invoice is paid or refunded
    this.registry.register({
      group: 'scheduling.payments',
      topics: [Topics.billing],
      handlers: {
        [EventTypes.paymentSucceeded]: async (e, db) => {
          const p = PaymentSucceeded.parse(e.data);
          if (p.sourceType === 'APPOINTMENT') await this.appts.onPaymentSucceeded(db!, p);
        },
        [EventTypes.refundProcessed]: (e, db) => this.appts.onRefundProcessed(db!, RefundProcessed.parse(e.data)),
      },
    });
  }
}

@Module({
  imports: [CoreModule.forRoot({ schema: 'scheduling', control: false, tenant: true, relay: true }), EntitlementsModule],
  controllers: [InternalAgendaController, UpcomingAppointmentsController, ScheduleController, AppointmentsController, InternalAppointmentsController, InternalNextSlotsController, DeskController, QueueController, InternalQueueController],
  providers: [ScheduleService, AppointmentsService, QueueService, PatientsClient, BillingClient, HorizonJob, NoShowJob, HoldExpiryJob, AgendaJob, SchedulingConsumers],
})
export class AppModule {}
