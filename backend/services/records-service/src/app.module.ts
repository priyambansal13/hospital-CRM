import { InternalEncounterStatusController, UnsignedEncountersController } from './records/encounter-status.controller.js';
import { TriageController, TriageService } from './records/triage.js';
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { AppointmentChanged, ConsentChanged, LabOrderChanged, DoctorChanged, EventTypes, PatientRegistered, TenantProvisioned, Topics } from '@mc/contracts';
import { ConsumerRegistry, CoreModule, isDev } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import type { Queryable } from '@mc/tenancy';
import { FieldCrypto } from './crypto/field-crypto.js';
import { DocumentsController, InternalCareAccessController, InternalDocumentsController, InternalStorageController } from './documents/documents.controller.js';
import { DocumentsService } from './documents/documents.service.js';
import { ScanJob } from './documents/scan.job.js';
import { ClamdScanner, EicarOnlyScanner, VIRUS_SCANNER, type VirusScanner } from './documents/scanner.js';
import { ObjectStorage } from './documents/storage.js';
import { TimelineService } from './timeline/timeline.service.js';
import { RecordAccess } from './records/access.js';
import { AuditClient } from './records/audit.client.js';
import { RecordsController } from './records/records.controller.js';
import { RecordsService } from './records/records.service.js';

/** Read models: doctors (who is a doctor), patients (demographics for documents), appointments (treating check). */
/** VIRUS_SCANNER=clamav (clamd host/port) everywhere real; "dev-eicar" only in dev (ClamAV needs ~1.3 GB RAM). */
function scannerFactory(): VirusScanner {
  const kind = process.env.VIRUS_SCANNER ?? (isDev() ? 'dev-eicar' : 'clamav');
  if (kind === 'clamav') return new ClamdScanner(process.env.CLAMD_HOST ?? 'localhost', Number(process.env.CLAMD_PORT ?? 3310));
  if (kind === 'dev-eicar' && isDev()) return new EicarOnlyScanner();
  throw new Error(`VIRUS_SCANNER=${kind} is not allowed here`);
}

@Injectable()
class RecordsConsumers implements OnModuleInit {
  constructor(private readonly registry: ConsumerRegistry, private readonly timeline: TimelineService, private readonly crypto: FieldCrypto, private readonly storage: ObjectStorage) {}
  onModuleInit() {
    // a new hospital: its own storage bucket and data encryption key, before anyone uploads or writes a note
    this.registry.register({
      group: 'records.tenant-setup', topics: [Topics.tenant],
      handlers: {
        [EventTypes.tenantProvisioned]: async (e) => {
          const t = TenantProvisioned.parse(e.data);
          await this.crypto.ensureKey(t.tenantId);
          await this.storage.ensureBucket(this.storage.bucketFor(t.slug));
        },
      },
    });
    const doctor = async (c: Queryable, data: unknown) => {
      const d = DoctorChanged.parse(data);
      await c.query(`INSERT INTO doctors (id, user_id, name, status) VALUES ($1,$2,$3,$4)
        ON CONFLICT (id) DO UPDATE SET user_id = $2, name = $3, status = $4, updated_at = now()`, [d.doctorId, d.userId, d.name, d.status]);
    };
    const patient = async (c: Queryable, data: unknown) => {
      const p = PatientRegistered.parse(data);
      await c.query(`INSERT INTO patients (id, account_person_id, mrn, name, dob, gender) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET account_person_id = $2, mrn = $3, name = $4, dob = coalesce($5, patients.dob), gender = coalesce($6, patients.gender), updated_at = now()`,
        [p.patientId, p.accountPersonId, p.mrn, p.name, p.dob, p.gender]);
    };
    const appt = async (c: Queryable, data: unknown) => {
      const a = AppointmentChanged.parse(data);
      await c.query(`INSERT INTO care_appointments (appointment_id, doctor_id, patient_id, branch_id, status, mode, starts_at, appointment_no) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (appointment_id) DO UPDATE SET status = $5, mode = coalesce($6, care_appointments.mode), starts_at = $7, updated_at = now()`,
        [a.appointmentId, a.doctorId, a.patientId, a.branchId, a.status, a.mode ?? null, a.startsAt, a.appointmentNo]);
    };
    this.registry.register({ group: 'records.doctors', topics: [Topics.provider], handlers: { [EventTypes.doctorCreated]: (e, db) => doctor(db!, e.data), [EventTypes.doctorUpdated]: (e, db) => doctor(db!, e.data) } });
    this.registry.register({ group: 'records.patients', topics: [Topics.patient], handlers: { [EventTypes.patientRegistered]: (e, db) => patient(db!, e.data), [EventTypes.patientUpdated]: (e, db) => patient(db!, e.data) } });
    const consent = async (c: Queryable, data: unknown) => {
      const x = ConsentChanged.parse(data);
      await c.query(`INSERT INTO consents (id, patient_id, doctor_id, scope, valid_until, revoked_at) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET scope = $4, valid_until = $5, revoked_at = $6`, [x.consentId, x.patientId, x.granteeDoctorId, x.scope, x.validUntil, x.revokedAt]);
    };
    this.registry.register({ group: 'records.consents', topics: [Topics.patient], handlers: { [EventTypes.consentGranted]: (e, db) => consent(db!, e.data), [EventTypes.consentRevoked]: (e, db) => consent(db!, e.data) } });
    // timeline: appointments (own consumer group so the whole history is replayed into the timeline once)
    const timelineAppt = async (c: Queryable, data: unknown) => {
      const a = AppointmentChanged.parse(data);
      if (['EXPIRED', 'PENDING_PAYMENT', 'RESCHEDULED'].includes(a.status)) return this.timeline.remove(c, 'APPOINTMENT', a.appointmentId);
      await this.timeline.upsert(c, {
        patientId: a.patientId, kind: 'APPOINTMENT', refId: a.appointmentId, occurredAt: a.startsAt, title: `Appointment with ${a.doctorName ?? 'doctor'}`,
        summary: { status: a.status, appointmentNo: a.appointmentNo, mode: a.mode ?? null, where: a.mode === 'VIDEO' ? 'Video' : a.branchName ?? null, cancelReason: a.reason ?? null },
        doctorId: a.doctorId, branchId: a.branchId,
      });
    };
    const tl = (e: any, db: any) => timelineAppt(db!, e.data);
    this.registry.register({
      group: 'records.timeline', topics: [Topics.scheduling],
      handlers: Object.fromEntries([EventTypes.appointmentBooked, EventTypes.appointmentCancelled, EventTypes.appointmentRescheduled, EventTypes.appointmentExpired,
        EventTypes.appointmentCompleted, EventTypes.appointmentNoShow].map((t) => [t, tl])),
    });
    // timeline: lab orders (test names are fine here: the patient's own record)
    const labEntry = async (c: Queryable, data: unknown) => {
      const o = LabOrderChanged.parse(data);
      if (['PENDING_PAYMENT', 'EXPIRED'].includes(o.status)) return this.timeline.remove(c, 'LAB_ORDER', o.orderId);
      const names = o.testNames.slice(0, 4).join(', ') + (o.testNames.length > 4 ? ` +${o.testNames.length - 4} more` : '');
      await this.timeline.upsert(c, {
        patientId: o.patientId, kind: 'LAB_ORDER', refId: o.orderId, occurredAt: o.slotAt ?? new Date().toISOString(), title: `Lab tests: ${names}`,
        summary: { status: o.status, orderNo: o.orderNo, orderedBy: o.orderedByName, where: o.branchName },
      });
    };
    const le = (e: any, db: any) => labEntry(db!, e.data);
    this.registry.register({
      group: 'records.lab-timeline', topics: [Topics.diagnostics],
      handlers: Object.fromEntries([EventTypes.labOrderOrdered, EventTypes.labOrderPendingPayment, EventTypes.labOrderBooked, EventTypes.labOrderCancelled, EventTypes.labOrderExpired,
        EventTypes.labOrderCollected, EventTypes.labOrderInLab, EventTypes.labOrderSampleRejected, EventTypes.labResultsEntered].map((t) => [t, le])),
    });
    const a = (e: any, db: any) => appt(db!, e.data);
    this.registry.register({
      group: 'records.appointments', topics: [Topics.scheduling],
      handlers: Object.fromEntries([EventTypes.appointmentBooked, EventTypes.appointmentPendingPayment, EventTypes.appointmentCancelled, EventTypes.appointmentRescheduled, EventTypes.appointmentExpired,
        EventTypes.appointmentCheckedIn, EventTypes.appointmentStarted, EventTypes.appointmentCompleted, EventTypes.appointmentNoShow].map((t) => [t, a])),
    });
  }
}

@Module({
  imports: [CoreModule.forRoot({ schema: 'records', control: true, tenant: true, relay: true }), EntitlementsModule],
  controllers: [TriageController, UnsignedEncountersController, RecordsController, DocumentsController, InternalCareAccessController, InternalDocumentsController, InternalStorageController, InternalEncounterStatusController],
  providers: [
    FieldCrypto, AuditClient, RecordAccess, RecordsService, TriageService, TimelineService, ObjectStorage, DocumentsService, ScanJob, RecordsConsumers,
    { provide: VIRUS_SCANNER, useFactory: scannerFactory },
  ],
})
export class AppModule {}
