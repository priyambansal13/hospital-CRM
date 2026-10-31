/**
 * @mc/contracts: event envelope, event payload schemas and shared API types.
 * Every event that crosses a service boundary is declared here (docs/MICROSERVICES.md §1, principle 7).
 */
import { z } from 'zod';

// ---------- event envelope (CloudEvents-like) ----------
export const EventEnvelope = z.object({
  specversion: z.literal('1.0'),
  id: z.uuid(),
  type: z.string(),
  source: z.string(),
  time: z.iso.datetime(),
  /** set for every tenant-scoped event; consumers use it to route to the tenant's own database */
  tenantId: z.uuid().optional(),
  subject: z.string().optional(),
  /** W3C trace context of the request that caused the event (CloudEvents distributed-tracing extension) */
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope<T = Record<string, unknown>> = Omit<z.infer<typeof EventEnvelope>, 'data'> & { data: T };

/** One topic per publishing service; the key is the aggregate id. */
export const Topics = {
  tenant: 'tenant.events',
  iam: 'iam.events',
  entitlement: 'entitlement.events',
  provider: 'provider.events',
  scheduling: 'scheduling.events',
  patient: 'patient.events',
  notification: 'notification.events',
  billing: 'billing.events',
  records: 'records.events',
  diagnostics: 'diagnostics.events',
  subscription: 'subscription.events',
} as const;

// ---------- event payloads ----------
export const TenantProvisioned = z.object({
  tenantId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  adminEmail: z.email(),
  hosts: z.array(z.string()),
  plan: z.string().nullable(),
  /** SIGNUP: self-serve (starts a trial); SALES: created by MediCare (CLI / console) */
  source: z.enum(['SALES', 'SIGNUP']).default('SALES'),
  /** the owner's name from signup (CLI-created hospitals: "Hospital Admin") */
  adminName: z.string().nullable().default(null),
});
export type TenantProvisioned = z.infer<typeof TenantProvisioned>;

export const TenantUpdated = z.object({ tenantId: z.uuid(), slug: z.string(), status: z.string() });
export type TenantUpdated = z.infer<typeof TenantUpdated>;

export const BranchChanged = z.object({ branchId: z.uuid(), name: z.string(), active: z.boolean(), timezone: z.string().default('Asia/Kolkata') });
export type BranchChanged = z.infer<typeof BranchChanged>;

export const StaffJoined = z.object({
  userId: z.uuid(),
  email: z.email(),
  name: z.string(),
  initialRoles: z.array(z.string()),
  /** the roles are given at this branch only (null/absent: every branch; review B-1) */
  branchId: z.uuid().nullable().optional(),
});
export type StaffJoined = z.infer<typeof StaffJoined>;

export const EntitlementsChanged = z.object({
  /** null = every user of the tenant is affected */
  userId: z.uuid().nullable(),
  reason: z.string(),
  version: z.number().int(),
});
export type EntitlementsChanged = z.infer<typeof EntitlementsChanged>;

/**
 * What a hospital is entitled to after a plan/contract change (docs/PRODUCT-MODULES-AND-PLANS.md §6, §8): the full
 * effective state, so entitlement-service can apply it without calling back. `seq` grows per tenant: older events are ignored.
 */
export const ContractChanged = z.object({
  contractId: z.uuid(),
  seq: z.number().int(),
  plan: z.object({ code: z.string(), name: z.string(), version: z.number().int(), edition: z.string(), listPrice: z.number() }),
  addons: z.array(z.object({ code: z.string(), name: z.string(), quantity: z.number().int() })),
  modules: z.array(z.object({ key: z.string(), source: z.enum(['PLAN', 'ADDON', 'OVERRIDE', 'TRIAL']) })),
  /** features of the included modules; limit null = unlimited */
  features: z.record(z.string(), z.object({ enabled: z.boolean(), limit: z.number().int().nullable(), overage: z.enum(['BLOCK', 'SOFT_WARN', 'ALLOW_BILL']).nullable().default(null) })),
  settingBounds: z.record(z.string(), z.object({ min: z.number().nullable().default(null), max: z.number().nullable().default(null), allowed: z.array(z.string()).nullable().default(null), locked: z.unknown().optional() })),
  reason: z.string(),
});
export type ContractChanged = z.infer<typeof ContractChanged>;

export const BillingStatus = z.enum(['NONE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'CANCELLED', 'EXPIRED']);
export type BillingStatus = z.infer<typeof BillingStatus>;

/**
 * The hospital's subscription changed state (docs/FEATURES-AND-PLANS.md §4.3). SUSPENDED / CANCELLED / EXPIRED make
 * every module but core read-only (records stay viewable, nothing new); GRACE / PAST_DUE show a banner to admins.
 */
export const SubscriptionStatusChanged = z.object({
  status: BillingStatus,
  seq: z.number().int(),
  trialEndsAt: z.string().nullable().default(null),
  graceEndsAt: z.string().nullable().default(null),
  periodEnd: z.string().nullable().default(null),
});
export type SubscriptionStatusChanged = z.infer<typeof SubscriptionStatusChanged>;

/** Something the hospital's account owner should hear about (e-mail): payment failed, grace, suspended, usage… */
export const BillingNotice = z.object({
  kind: z.enum(['TRIAL_ENDING', 'TRIAL_CONVERTED', 'PAYMENT_FAILED', 'GRACE_STARTED', 'SUSPENDED', 'PAYMENT_RECEIVED', 'USAGE_80', 'USAGE_100',
    // review 4.G: the owner also hears when the subscription ends or comes back, a bank-transfer invoice, a plan change by MediCare
    'EXPIRED', 'CANCELLED', 'REACTIVATED', 'INVOICE_ISSUED', 'PLAN_CHANGED']),
  /** PLAN_CHANGED: the new plan's name */
  plan: z.string().nullable().default(null),
  invoiceNo: z.string().nullable().default(null),
  amount: z.number().nullable().default(null),
  date: z.string().nullable().default(null),
  feature: z.string().nullable().default(null),
  used: z.number().nullable().default(null),
  limit: z.number().nullable().default(null),
  dedupe: z.string(),
});
export type BillingNotice = z.infer<typeof BillingNotice>;

/** entitlement-service: a module finished activating (ACTIVE) or disabling (READ_ONLY) for a hospital. */
export const ModuleStateChanged = z.object({ module: z.string(), state: z.enum(['ACTIVE', 'READ_ONLY']) });
export type ModuleStateChanged = z.infer<typeof ModuleStateChanged>;

export const DoctorChanged = z.object({
  doctorId: z.uuid(),
  userId: z.uuid().nullable(),
  name: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']),
  specialtyCodes: z.array(z.string()),
  branchIds: z.array(z.uuid()),
  /** consultation fee per branch (older events lack it; provider can republish) */
  branchFees: z.array(z.object({ branchId: z.uuid(), fee: z.number(), followupFee: z.number().nullable() })).default([]),
});
export type DoctorChanged = z.infer<typeof DoctorChanged>;

/** A doctor's bookable time changed (templates, leave, generation); search uses it for "next available". */
export const AvailabilityChanged = z.object({ doctorId: z.uuid(), reason: z.string() });
export type AvailabilityChanged = z.infer<typeof AvailabilityChanged>;

export const PatientRegistered = z.object({
  patientId: z.uuid(), accountPersonId: z.uuid(), guardianId: z.uuid().nullable(), mrn: z.string(), name: z.string(),
  /** contact details of the account holder (dependents use their guardian's) */
  phone: z.string().nullable().default(null), email: z.string().nullable().default(null),
  /** for clinical documents (prescriptions show age and sex); older events lack them, patient-service can republish */
  dob: z.string().nullable().default(null), gender: z.string().nullable().default(null),
});
export type PatientRegistered = z.infer<typeof PatientRegistered>;

export const AppointmentChanged = z.object({
  appointmentId: z.uuid(),
  appointmentNo: z.string(),
  patientId: z.uuid(),
  accountPersonId: z.uuid(),
  doctorId: z.uuid(),
  branchId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  status: z.string(),
  reason: z.string().nullable().optional(),
  // display fields, so consumers (notifications) don't need their own read models
  patientName: z.string().optional(),
  patientMrn: z.string().optional(),
  doctorName: z.string().optional(),
  branchName: z.string().optional(),
  localDate: z.string().optional(),
  localTime: z.string().optional(),
  mode: z.string().optional(),
  fee: z.number().nullable().optional(),
  rescheduledFrom: z.uuid().nullable().optional(),
  /** queue token (set at check-in) and how it was booked: ONLINE, DESK (front desk into a slot), WALK_IN (no slot) */
  tokenNo: z.number().int().nullable().optional(),
  source: z.enum(['ONLINE', 'DESK', 'WALK_IN']).optional(),
  // payments (Phase 11)
  paymentMode: z.enum(['ONLINE', 'AT_CLINIC']).optional(),
  paymentStatus: z.string().optional(),
  invoiceId: z.uuid().nullable().optional(),
  /** set on cancellation: share of what was paid that goes back (cancellation policy, decided by scheduling) */
  refundPercent: z.number().int().min(0).max(100).nullable().optional(),
  /** the doctor's login (same-day changes are e-mailed to them) */
  doctorUserId: z.uuid().nullable().optional(),
});
export type AppointmentChanged = z.infer<typeof AppointmentChanged>;

/** A doctor's list for the day, sent each morning (scheduling-service AgendaJob → notification e-mail). */
export const DoctorAgenda = z.object({
  doctorId: z.uuid(), doctorUserId: z.uuid(), doctorName: z.string(), date: z.string(),
  items: z.array(z.object({ time: z.string(), patientName: z.string(), appointmentNo: z.string(), branchName: z.string(), mode: z.string() })),
});
export type DoctorAgenda = z.infer<typeof DoctorAgenda>;

export const WaitlistSlotAvailable = z.object({ waitlistId: z.uuid(), patientId: z.uuid(), accountPersonId: z.uuid(), doctorId: z.uuid(), date: z.string(), slotId: z.uuid() });
export type WaitlistSlotAvailable = z.infer<typeof WaitlistSlotAvailable>;

/** billing.payment_succeeded: an invoice is paid in full (online or at the counter). */
export const PaymentSucceeded = z.object({
  invoiceId: z.uuid(), invoiceNo: z.string(), paymentId: z.uuid(),
  sourceType: z.enum(['APPOINTMENT', 'LAB_ORDER', 'MEMBERSHIP']), sourceId: z.uuid(),
  accountPersonId: z.uuid(), patientName: z.string(),
  amount: z.number(), method: z.string().nullable(), channel: z.enum(['ONLINE', 'COUNTER']),
});
export type PaymentSucceeded = z.infer<typeof PaymentSucceeded>;

/** Membership benefits (Phase 26): what a tier gives its members (each hospital sets its own). */
export const MembershipBenefits = z.object({
  bookingWindowDays: z.number().int().min(1).max(180),
  priorityAccess: z.boolean(),
  freeVideoConsultsPerMonth: z.number().int().min(0).max(30),
  labDiscountPct: z.number().int().min(0).max(50),
  freeHomeCollection: z.boolean(),
  familyMembers: z.number().int().min(1).max(10),
});
export type MembershipBenefits = z.infer<typeof MembershipBenefits>;

/** billing.membership_changed: an account joined, renewed, or its membership ended. */
export const MembershipChanged = z.object({
  membershipId: z.uuid(), accountPersonId: z.uuid(), patientName: z.string(), planCode: z.string(), planName: z.string(),
  status: z.enum(['ACTIVE', 'EXPIRED', 'CANCELLED']), endsAt: z.string(), benefits: MembershipBenefits,
});
export type MembershipChanged = z.infer<typeof MembershipChanged>;

/** billing.refund_processed: money is on its way back; invoiceStatus is REFUNDED or PARTIALLY_REFUNDED. */
export const RefundProcessed = z.object({
  invoiceId: z.uuid(), invoiceNo: z.string(), refundId: z.uuid(),
  sourceType: z.enum(['APPOINTMENT', 'LAB_ORDER', 'MEMBERSHIP']), sourceId: z.uuid(),
  accountPersonId: z.uuid(), patientName: z.string(),
  amount: z.number(), invoiceStatus: z.string(), reason: z.string().nullable(),
});
export type RefundProcessed = z.infer<typeof RefundProcessed>;

/** scheduling.payment_unapplied: a payment arrived for an appointment that could not be confirmed (slot lost). */
export const PaymentUnapplied = z.object({ appointmentId: z.uuid(), invoiceId: z.uuid(), paymentId: z.uuid(), reason: z.string() });
export type PaymentUnapplied = z.infer<typeof PaymentUnapplied>;

/** records events carry ids only (no clinical text): consumers fetch details through records-service, which audits. */
export const PrescriptionIssued = z.object({
  prescriptionId: z.uuid(), prescriptionNo: z.string(), encounterId: z.uuid(), patientId: z.uuid(), accountPersonId: z.uuid(),
  patientName: z.string(), doctorId: z.uuid(), doctorName: z.string(), itemCount: z.number().int(),
  /** the doctor wants to see the patient again on this date (a reminder goes out the day before) */
  followUpOn: z.iso.date().nullable().optional(),
});
export type PrescriptionIssued = z.infer<typeof PrescriptionIssued>;

export const BreakGlassGranted = z.object({ grantId: z.uuid(), patientId: z.uuid(), doctorId: z.uuid(), doctorName: z.string(), reason: z.string(), expiresAt: z.iso.datetime({ offset: true }) });
export type BreakGlassGranted = z.infer<typeof BreakGlassGranted>;

/** Lab order lifecycle (diagnostics-service). Display fields so consumers (billing, notifications, timeline) need no read model. */
export const LabOrderChanged = z.object({
  orderId: z.uuid(), orderNo: z.string(), patientId: z.uuid(), accountPersonId: z.uuid(), patientName: z.string(), patientMrn: z.string(),
  branchId: z.uuid().nullable(), branchName: z.string().nullable(), status: z.string(),
  paymentMode: z.enum(['ONLINE', 'AT_CLINIC']).nullable(), paymentStatus: z.string(), invoiceId: z.uuid().nullable(),
  total: z.number(), testNames: z.array(z.string()), slotAt: z.iso.datetime({ offset: true }).nullable(),
  localDate: z.string().nullable(), localTime: z.string().nullable(), preparation: z.string().nullable(),
  orderedByDoctorId: z.uuid().nullable(), orderedByName: z.string().nullable(), encounterId: z.uuid().nullable(),
  refundPercent: z.number().int().min(0).max(100).nullable().optional(),
  collectionType: z.enum(['AT_LAB', 'HOME']).optional(),
});
export type LabOrderChanged = z.infer<typeof LabOrderChanged>;

/** A verified lab report was published (or re-published after an amendment). No values in the event. */
export const LabReportPublished = z.object({
  orderId: z.uuid(), orderNo: z.string(), reportId: z.uuid(), version: z.number().int(), amended: z.boolean(),
  documentId: z.uuid().nullable(), patientId: z.uuid(), accountPersonId: z.uuid(), patientName: z.string(), patientMrn: z.string(),
  abnormalCount: z.number().int(), criticalCount: z.number().int(), orderedByUserId: z.uuid().nullable(), orderedByName: z.string().nullable(),
});
export type LabReportPublished = z.infer<typeof LabReportPublished>;

/** A home sample collection changed state (assigned, on the way, collected, missed). No test names. */
export const HomeVisitChanged = z.object({
  visitId: z.uuid(), orderId: z.uuid(), orderNo: z.string(), status: z.string(), patientId: z.uuid(), accountPersonId: z.uuid(), patientName: z.string(),
  branchName: z.string().nullable(), slotAt: z.iso.datetime({ offset: true }), localDate: z.string(), localTime: z.string(), pincode: z.string(),
  phlebotomistUserId: z.uuid().nullable(), phlebotomistName: z.string().nullable(), reason: z.string().nullable(),
});
export type HomeVisitChanged = z.infer<typeof HomeVisitChanged>;

/** A critical value was entered: the ordering doctor (or the pathologist) must act now. Values stay in the app. */
export const LabCriticalValue = z.object({
  alertId: z.uuid(), orderId: z.uuid(), orderNo: z.string(), patientId: z.uuid(), patientName: z.string(), patientMrn: z.string(),
  testName: z.string(), parameter: z.string(), orderedByUserId: z.uuid().nullable(), orderedByName: z.string().nullable(),
  branchId: z.uuid().nullable().optional(),
});
export type LabCriticalValue = z.infer<typeof LabCriticalValue>;

/**
 * Nobody has acknowledged a critical value (review C-2): level 1 = the branch's pathologists (phone the doctor, record
 * the read-back), level 2 = whoever is on call for escalations at the branch (branch admin).
 */
export const LabCriticalEscalated = LabCriticalValue.extend({ level: z.number().int().min(1).max(2), minutesOpen: z.number().int() });
export type LabCriticalEscalated = z.infer<typeof LabCriticalEscalated>;

/** A patient shares (part of) their record with a doctor for a while (owned by patient-service). */
export const ConsentScope = z.enum(['NOTES', 'PRESCRIPTIONS', 'DOCUMENTS']);
export const ConsentChanged = z.object({
  consentId: z.uuid(), patientId: z.uuid(), granteeDoctorId: z.uuid(), scope: z.array(ConsentScope).min(1),
  validUntil: z.iso.datetime({ offset: true }), revokedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ConsentChanged = z.infer<typeof ConsentChanged>;

/** One audit entry (written synchronously by the service that touched patient data; docs/LLD.md §15). */
export const AuditEntry = z.object({
  actorId: z.string().min(1).max(64),
  actorKind: z.enum(['staff', 'patient', 'system']),
  actorName: z.string().max(120).nullable().default(null),
  action: z.enum(['READ', 'CREATE', 'UPDATE', 'DELETE', 'SIGN', 'AMEND', 'EXPORT', 'BREAK_GLASS', 'LOOKUP', 'DENIED']),
  resourceType: z.string().min(2).max(40),
  resourceId: z.uuid().nullable().default(null),
  patientId: z.uuid().nullable().default(null),
  purpose: z.enum(['TREATMENT', 'BREAK_GLASS', 'CONSENT', 'PATIENT_SELF', 'ADMIN', 'NONE']),
  requestId: z.string().max(64).nullable().default(null),
  ip: z.string().max(64).nullable().default(null),
  /** field names that changed (never clinical text) */
  changes: z.array(z.string().max(40)).max(40).nullable().default(null),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** The hospital's payout bank account was connected or replaced (review B-5): the owners are told. */
export const PayoutAccountChanged = z.object({
  change: z.enum(['CONNECTED', 'REPLACED']), by: z.string(), bankLast4: z.string().nullable(), ifsc: z.string().nullable(),
  prevBankLast4: z.string().nullable(), holdUntil: z.iso.datetime({ offset: true }).nullable(),
});
export type PayoutAccountChanged = z.infer<typeof PayoutAccountChanged>;

/**
 * A message for MediCare's own staff (review 4.G): everyone in the HQ account holding `permission` gets it by e-mail
 * (plans waiting for approval, approved or rejected).
 */
export const StaffNotice = z.object({ permission: z.string(), subject: z.string(), message: z.string(), linkPath: z.string(), dedupe: z.string() });
export type StaffNotice = z.infer<typeof StaffNotice>;

export const EventTypes = {
  tenantProvisioned: 'tenant.provisioned',
  tenantUpdated: 'tenant.updated',
  branchCreated: 'tenant.branch_created',
  branchUpdated: 'tenant.branch_updated',
  staffJoined: 'iam.staff_joined',
  entitlementsChanged: 'entitlement.entitlements_changed',
  moduleStateChanged: 'entitlement.module_state_changed',
  contractChanged: 'subscription.contract_changed',
  subscriptionStatusChanged: 'subscription.status_changed',
  billingNotice: 'subscription.billing_notice',
  staffNotice: 'subscription.staff_notice',
  doctorCreated: 'provider.doctor_created',
  doctorUpdated: 'provider.doctor_updated',
  availabilityChanged: 'scheduling.availability_changed',
  appointmentBooked: 'scheduling.appointment_booked',
  appointmentCancelled: 'scheduling.appointment_cancelled',
  appointmentRescheduled: 'scheduling.appointment_rescheduled',
  waitlistSlotAvailable: 'scheduling.waitlist_slot_available',
  appointmentCheckedIn: 'scheduling.appointment_checked_in',
  appointmentStarted: 'scheduling.appointment_started',
  appointmentCompleted: 'scheduling.appointment_completed',
  appointmentNoShow: 'scheduling.appointment_no_show',
  appointmentPendingPayment: 'scheduling.appointment_pending_payment',
  appointmentExpired: 'scheduling.appointment_expired',
  doctorAgenda: 'scheduling.doctor_agenda',
  paymentUnapplied: 'scheduling.payment_unapplied',
  paymentSucceeded: 'billing.payment_succeeded',
  membershipChanged: 'billing.membership_changed',
  refundProcessed: 'billing.refund_processed',
  invoiceVoided: 'billing.invoice_voided',
  encounterSigned: 'records.encounter_signed',
  prescriptionIssued: 'records.prescription_issued',
  breakGlassGranted: 'records.break_glass_granted',
  documentAvailable: 'records.document_available',
  labOrderOrdered: 'diagnostics.lab_order_ordered',
  labOrderPendingPayment: 'diagnostics.lab_order_pending_payment',
  labOrderBooked: 'diagnostics.lab_order_booked',
  labOrderCancelled: 'diagnostics.lab_order_cancelled',
  labOrderExpired: 'diagnostics.lab_order_expired',
  labOrderCollected: 'diagnostics.lab_order_sample_collected',
  labOrderInLab: 'diagnostics.lab_order_in_lab',
  labOrderSampleRejected: 'diagnostics.lab_order_sample_rejected',
  labPaymentUnapplied: 'diagnostics.payment_unapplied',
  labResultsEntered: 'diagnostics.lab_order_results_entered',
  labReportPublished: 'diagnostics.report_published',
  labCriticalValue: 'diagnostics.critical_value',
  payoutAccountChanged: 'billing.payout_account_changed',
  labCriticalEscalated: 'diagnostics.critical_escalated',
  labTatBreached: 'diagnostics.tat_breached',
  homeVisitAssigned: 'diagnostics.home_visit_assigned',
  homeVisitEnRoute: 'diagnostics.home_visit_en_route',
  homeVisitCollected: 'diagnostics.home_visit_collected',
  homeVisitMissed: 'diagnostics.home_visit_missed',
  consentGranted: 'patient.consent_granted',
  consentRevoked: 'patient.consent_revoked',
  patientRegistered: 'patient.registered',
  patientUpdated: 'patient.updated',
} as const;

// ---------- shared value types ----------
/** Mobile number in E.164; a bare 10-digit number is treated as Indian (+91). */
export const PhoneNumber = z.string().trim().transform((s) => s.replace(/[\s-]/g, '')).transform((s) => (/^\d{10}$/.test(s) ? `+91${s}` : s)).pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164'));

// ---------- shared API types ----------
export type ActorKind = 'staff' | 'patient';

export interface NavItem {
  key: string;
  label: string;
  href: string;
  zone: string;
}

export interface FeatureState {
  enabled: boolean;
  limit?: number | null;
  /** metered features: what happens beyond the limit */
  overage?: 'BLOCK' | 'SOFT_WARN' | 'ALLOW_BILL' | null;
  used?: number;
  reason?: 'MODULE' | 'PLAN' | 'FLAG';
}

export type ModuleState = 'ACTIVATING' | 'ACTIVE' | 'DISABLING' | 'READ_ONLY';

/** GET /v1/me/capabilities (docs/MICROFRONTENDS.md §4) */
export interface Capabilities {
  tenant: { id: string; slug: string };
  actor: { id: string; kind: ActorKind };
  roles: string[];
  /** modules in full use */
  modules: string[];
  /** modules no longer in the plan: their data can still be read, nothing new can be created (GET only) */
  readOnlyModules: string[];
  /** modules being switched on (seed data, jobs) */
  activatingModules: string[];
  plan: { code: string; name: string } | null;
  /** the hospital's MediCare subscription (banners; SUSPENDED etc. already reflected in modules/readOnlyModules) */
  billing: { status: string; graceEndsAt: string | null; trialEndsAt: string | null };
  permissions: string[];
  /**
   * ":branch" permissions granted only at some branches (review B-1): permission → branch ids. A permission that is
   * missing here but present in `permissions` covers every branch.
   */
  branchScopes?: Record<string, string[]>;
  /** the branches this person works at (union of their role grants); null = every branch (screens default to these) */
  branchIds?: string[] | null;
  features: Record<string, FeatureState>;
  nav: NavItem[];
  home: string;
  version: number;
}

/** What the realtime gateway pushes to queue screens: a signal only (no names); screens re-fetch what they show. */
export interface QueueSignal {
  type: string;
  appointmentId: string;
  doctorId: string;
  branchId: string;
  status: string;
  tokenNo: number | null;
  localDate: string | null;
}

/** Tenant placement as returned by tenant-service (docs/MULTI-TENANCY.md §3.2) */
export interface TenantPlacement {
  id: string;
  slug: string;
  name: string;
  status: 'PROVISIONING' | 'ACTIVE' | 'READ_ONLY' | 'SUSPENDED' | 'DELETED';
  dbName: string;
  dbHost: string;
  dbPort: number;
  hosts: string[];
}

/** RFC 7807 problem body used by every service */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  [extra: string]: unknown;
}
