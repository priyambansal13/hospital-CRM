import { Inject, Injectable, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { AppointmentChanged, DoctorAgenda, EventTypes, PayoutAccountChanged, StaffNotice, HomeVisitChanged, LabCriticalEscalated, LabCriticalValue, LabOrderChanged, LabReportPublished, PatientRegistered, PaymentSucceeded, PrescriptionIssued, RefundProcessed, Topics, WaitlistSlotAvailable, BillingNotice, WorkflowNotify } from '@mc/contracts';
import { ConsumerRegistry, CoreModule, PLACEMENTS, retryInBackground } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { EmailChannel, SmsChannel } from './channels/channels.js';
import { DispatcherJob } from './notify/dispatcher.job.js';
import { NotificationsController } from './notify/notifications.controller.js';
import { PlannerService } from './notify/planner.service.js';

@Injectable()
class NotificationConsumers implements OnModuleInit, OnApplicationBootstrap {
  constructor(private readonly registry: ConsumerRegistry, private readonly planner: PlannerService, private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  onModuleInit() {
    this.registry.register({
      group: 'notification.tenant-setup',
      topics: [Topics.tenant],
      handlers: {
        [EventTypes.tenantProvisioned]: (_e, db) => this.planner.seedTemplates(db!),
        // tenant-service tells MediCare support about failed signups (to the HQ account)
        [EventTypes.staffNotice]: (e, db) => this.planner.onStaffNotice(db!, StaffNotice.parse(e.data)),
      },
    });
    this.registry.register({
      group: 'notification.patients',
      topics: [Topics.patient],
      handlers: {
        [EventTypes.patientRegistered]: (e, db) => this.planner.onPatient(db!, PatientRegistered.parse(e.data)),
        [EventTypes.patientUpdated]: (e, db) => this.planner.onPatient(db!, PatientRegistered.parse(e.data)),
      },
    });
    const appt = (type: string) => (e: any, db: any) => this.planner.onAppointment(db!, type, AppointmentChanged.parse(e.data), e.time);
    this.registry.register({
      group: 'notification.appointments',
      topics: [Topics.scheduling],
      handlers: {
        [EventTypes.appointmentBooked]: appt(EventTypes.appointmentBooked),
        [EventTypes.appointmentRescheduled]: appt(EventTypes.appointmentRescheduled),
        [EventTypes.appointmentCancelled]: appt(EventTypes.appointmentCancelled),
        [EventTypes.appointmentExpired]: appt(EventTypes.appointmentExpired),
        [EventTypes.doctorAgenda]: (e, db) => this.planner.onDoctorAgenda(db!, DoctorAgenda.parse(e.data)),
        [EventTypes.waitlistSlotAvailable]: (e, db) => this.planner.onWaitlist(db!, { ...WaitlistSlotAvailable.parse(e.data), doctorName: (e.data as any).doctorName }, e.time),
      },
    });
    this.registry.register({
      group: 'notification.workflows',
      topics: [Topics.integration],
      handlers: { [EventTypes.workflowNotify]: (e, db) => this.planner.onWorkflowNotify(db!, WorkflowNotify.parse(e.data)) },
    });
    this.registry.register({
      group: 'notification.billing',
      topics: [Topics.billing],
      handlers: {
        [EventTypes.paymentSucceeded]: (e, db) => this.planner.onPayment(db!, PaymentSucceeded.parse(e.data)),
        [EventTypes.refundProcessed]: (e, db) => this.planner.onRefund(db!, RefundProcessed.parse(e.data)),
        [EventTypes.payoutAccountChanged]: (e, db) => this.planner.onPayoutChanged(db!, PayoutAccountChanged.parse(e.data), e.id),
      },
    });
    const labMsg = (type: string) => (e: any, db: any) => this.planner.onLabOrder(db!, type, LabOrderChanged.parse(e.data), e.time);
    this.registry.register({
      group: 'notification.lab',
      topics: [Topics.diagnostics],
      handlers: {
        ...Object.fromEntries([EventTypes.labOrderBooked, EventTypes.labOrderOrdered, EventTypes.labOrderSampleRejected, EventTypes.labOrderCancelled, EventTypes.labOrderExpired].map((t) => [t, labMsg(t)])),
        [EventTypes.labTatBreached]: (e, db) => this.planner.onTatBreached(db!, LabOrderChanged.parse(e.data)),
        [EventTypes.labReportPublished]: (e, db) => this.planner.onLabReport(db!, LabReportPublished.parse(e.data)),
        [EventTypes.labCriticalValue]: (e, db) => this.planner.onCriticalValue(db!, LabCriticalValue.parse(e.data)),
        [EventTypes.labCriticalEscalated]: (e, db) => this.planner.onCriticalEscalated(db!, LabCriticalEscalated.parse(e.data)),
        ...Object.fromEntries([EventTypes.homeVisitAssigned, EventTypes.homeVisitEnRoute, EventTypes.homeVisitMissed].map((t) => [t, (e: any, db: any) => this.planner.onHomeVisit(db!, t, HomeVisitChanged.parse(e.data), e.time)])),
      },
    });
    this.registry.register({
      group: 'notification.subscription',
      topics: [Topics.subscription],
      handlers: {
        [EventTypes.billingNotice]: (e, db) => this.planner.onBillingNotice(db!, BillingNotice.parse(e.data)),
        [EventTypes.staffNotice]: (e, db) => this.planner.onStaffNotice(db!, StaffNotice.parse(e.data)),
      },
    });
    this.registry.register({
      group: 'notification.records',
      topics: [Topics.records],
      handlers: { [EventTypes.prescriptionIssued]: (e, db) => this.planner.onPrescription(db!, PrescriptionIssued.parse(e.data)) },
    });
  }

  /** Hospitals created before this service existed get the default templates too. */
  onApplicationBootstrap() {
    retryInBackground('TemplateSeed', async () => {
      for (const t of await this.placements.list()) {
        if (t.status === 'ACTIVE') await TenantContext.run(t, () => this.db.tx((c) => this.planner.seedTemplates(c)));
      }
    });
  }
}

@Module({
  imports: [CoreModule.forRoot({ schema: 'notification', control: false, tenant: true, relay: true }), EntitlementsModule],
  controllers: [NotificationsController],
  providers: [PlannerService, DispatcherJob, EmailChannel, SmsChannel, NotificationConsumers],
})
export class AppModule {}
