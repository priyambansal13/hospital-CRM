import { EventTypes } from '@mc/contracts';

/**
 * Events a hospital can subscribe its systems to (Phase 27): our internal event → the public name and a payload with
 * identifiers and what a HIS needs to file it. No clinical values (a lab report says it is ready, not what it says;
 * the FHIR API, with an API key, gives the values).
 */
type Data = Record<string, any>;
const appt = (d: Data) => ({
  appointmentId: d.appointmentId, appointmentNo: d.appointmentNo, status: d.status, startsAt: d.startsAt, localDate: d.localDate ?? null, localTime: d.localTime ?? null,
  mode: d.mode ?? null, source: d.source ?? null, patient: { id: d.patientId, mrn: d.patientMrn ?? null, name: d.patientName ?? null },
  doctor: { id: d.doctorId, name: d.doctorName ?? null }, branch: { id: d.branchId, name: d.branchName ?? null }, fee: d.fee ?? null, paymentStatus: d.paymentStatus ?? null,
});
const lab = (d: Data) => ({
  orderId: d.orderId, orderNo: d.orderNo, status: d.status, patient: { id: d.patientId, mrn: d.patientMrn, name: d.patientName }, branch: d.branchId ? { id: d.branchId, name: d.branchName } : null,
  tests: d.testNames, slotAt: d.slotAt ?? null, collectionType: d.collectionType ?? null, total: d.total, paymentStatus: d.paymentStatus,
});

export const WEBHOOK_EVENTS: Record<string, { internal: string; label: string; map: (d: Data) => Data }> = {
  'appointment.booked': { internal: EventTypes.appointmentBooked, label: 'Appointment booked', map: appt },
  'appointment.rescheduled': { internal: EventTypes.appointmentRescheduled, label: 'Appointment moved', map: appt },
  'appointment.cancelled': { internal: EventTypes.appointmentCancelled, label: 'Appointment cancelled', map: appt },
  'appointment.checked_in': { internal: EventTypes.appointmentCheckedIn, label: 'Patient checked in', map: appt },
  'appointment.completed': { internal: EventTypes.appointmentCompleted, label: 'Visit completed', map: appt },
  'appointment.no_show': { internal: EventTypes.appointmentNoShow, label: 'No-show', map: appt },
  'patient.registered': { internal: EventTypes.patientRegistered, label: 'Patient registered', map: (d) => ({ patientId: d.patientId, mrn: d.mrn, name: d.name, dob: d.dob ?? null, gender: d.gender ?? null, phone: d.phone ?? null, email: d.email ?? null, guardianId: d.guardianId }) },
  'patient.updated': { internal: EventTypes.patientUpdated, label: 'Patient details changed', map: (d) => ({ patientId: d.patientId, mrn: d.mrn, name: d.name, dob: d.dob ?? null, gender: d.gender ?? null, phone: d.phone ?? null, email: d.email ?? null, guardianId: d.guardianId }) },
  'lab_order.booked': { internal: EventTypes.labOrderBooked, label: 'Lab tests booked', map: lab },
  'lab_order.collected': { internal: EventTypes.labOrderCollected, label: 'Lab sample collected', map: lab },
  'lab_order.cancelled': { internal: EventTypes.labOrderCancelled, label: 'Lab order cancelled', map: lab },
  'lab_report.published': { internal: EventTypes.labReportPublished, label: 'Lab report ready', map: (d) => ({ orderId: d.orderId, orderNo: d.orderNo, reportId: d.reportId, version: d.version, amended: d.amended, patient: { id: d.patientId, mrn: d.patientMrn, name: d.patientName }, abnormalCount: d.abnormalCount, criticalCount: d.criticalCount }) },
  'payment.succeeded': { internal: EventTypes.paymentSucceeded, label: 'Payment received', map: (d) => ({ invoiceId: d.invoiceId, invoiceNo: d.invoiceNo, paymentId: d.paymentId, amount: d.amount, method: d.method ?? null, channel: d.channel, sourceType: d.sourceType, sourceId: d.sourceId }) },
};
export const publicName = (internal: string) => Object.entries(WEBHOOK_EVENTS).find(([, v]) => v.internal === internal)?.[0];
