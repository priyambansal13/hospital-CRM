'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import { errorText, myPatients } from './booking';

/** Redirect within the patient zone (same zone: a server-action redirect is fine here). */
const go = async (path: string, q: Record<string, string> = {}) => {
  const safe = path.startsWith('/care') ? path : '/care';
  const qs = new URLSearchParams(q).toString();
  redirect(`${await origin()}${safe}${qs ? `?${qs}` : ''}`);
};

async function patientSession() {
  const s = await actionSession();
  if (s.kind !== 'patient') return go('/care', { error: 'Sign in as a patient to book.' }) as never;
  return s;
}

export async function bookAppointment(f: FormData) {
  const { accessToken: token } = await patientSession();
  const slotId = String(f.get('slotId'));
  const paymentMode = f.get('paymentMode') === 'ONLINE' ? 'ONLINE' : 'AT_CLINIC';
  let appt: { appointmentNo: string; id: string; payment?: { invoiceId: string } };
  try {
    appt = await api('/api/scheduling/v1/appointments', {
      token, idempotencyKey: String(f.get('idempotencyKey')),
      body: { slotId, patientId: f.get('patientId'), reason: String(f.get('reason') ?? '').trim() || null, paymentMode },
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') return go(`/care/doctors/${f.get('doctorId')}`, { error: 'Sorry, that time was just booked by someone else. Please pick another time.' });
    return go(`/care/book/${slotId}`, { error: errorText(e) });
  }
  if (appt.payment) return go(`/care/pay/${appt.payment.invoiceId}`);
  return go('/care/appointments', { ok: `Booked! Your appointment number is ${appt.appointmentNo}. Pay at the hospital.` });
}

export async function cancelAppointment(f: FormData) {
  const { accessToken: token } = await patientSession();
  try {
    await api(`/api/scheduling/v1/appointments/${f.get('id')}/cancel`, { token, body: { reason: null } });
  } catch (e) {
    return go('/care/appointments', { error: errorText(e) });
  }
  return go('/care/appointments', { ok: 'Appointment cancelled.' });
}

export async function rescheduleAppointment(f: FormData) {
  const { accessToken: token } = await patientSession();
  const id = String(f.get('id'));
  let appt: { appointmentNo: string };
  try {
    appt = await api(`/api/scheduling/v1/appointments/${id}/reschedule`, { token, body: { newSlotId: f.get('newSlotId') } });
  } catch (e) {
    return go(`/care/appointments/${id}/reschedule`, { error: errorText(e) });
  }
  return go('/care/appointments', { ok: `Rescheduled. New appointment number ${appt.appointmentNo}.` });
}

export async function saveProfile(f: FormData) {
  const { accessToken: token } = await patientSession();
  const back = String(f.get('back') ?? '/care/profile');
  try {
    await api('/api/patient/v1/me/profile', { token, method: 'PUT', body: { fullName: f.get('fullName'), dob: f.get('dob'), gender: f.get('gender') || null, email: String(f.get('email') ?? '') || null } });
  } catch (e) {
    return go(back, { error: errorText(e) });
  }
  return go(back, { ok: 'Profile saved.' });
}

export async function addDependent(f: FormData) {
  const { accessToken: token } = await patientSession();
  const back = String(f.get('back') ?? '/care/profile');
  try {
    await api('/api/patient/v1/me/dependents', { token, body: { fullName: f.get('fullName'), dob: f.get('dob'), gender: f.get('gender') || null, relation: f.get('relation') } });
  } catch (e) {
    return go(back, { error: errorText(e) });
  }
  return go(back, { ok: `${f.get('fullName')} added to your family.` });
}

export async function joinWaitlist(f: FormData) {
  const { accessToken: token } = await patientSession();
  const doctorId = String(f.get('doctorId'));
  const self = (await myPatients(token)).find((p) => p.isSelf);
  if (!self) return go('/care/profile', { error: 'Complete your profile first.' });
  try {
    await api('/api/scheduling/v1/waitlist', { token, body: { doctorId, date: f.get('date'), patientId: f.get('patientId') || self.id } });
  } catch (e) {
    return go(`/care/doctors/${doctorId}`, { error: errorText(e) });
  }
  return go(`/care/doctors/${doctorId}`, { ok: "You're on the waitlist. We'll tell you if a time opens up that day." });
}

export async function saveNotificationPrefs(f: FormData) {
  const { accessToken: token } = await patientSession();
  try {
    await api('/api/notification/v1/me/notification-preferences', { token, method: 'PUT', body: { smsEnabled: f.get('sms') === 'on', emailEnabled: f.get('email') === 'on', language: f.get('language') } });
  } catch (e) {
    return go('/care/profile', { error: errorText(e) });
  }
  return go('/care/profile', { ok: 'Message preferences saved.' });
}

/** Razorpay Checkout success: the three fields go to billing-service, which checks the signature and the payment. */
export async function verifyPayment(f: FormData) {
  const { accessToken: token } = await patientSession();
  const invoiceId = String(f.get('invoiceId'));
  try {
    await api('/api/billing/v1/payments/verify', { token, body: { orderId: f.get('razorpay_order_id'), paymentId: f.get('razorpay_payment_id'), signature: f.get('razorpay_signature') } });
  } catch (e) {
    return go(`/care/pay/${invoiceId}`, { error: errorText(e) });
  }
  return go(`/care/pay/${invoiceId}`, { ok: 'Payment received.' });
}

/** Dev (simulated gateway): what Razorpay Checkout would do, then the same verification as a real payment. */
export async function simulatePayment(f: FormData) {
  const { accessToken: token } = await patientSession();
  const invoiceId = String(f.get('invoiceId'));
  const outcome = f.get('outcome') === 'failure' ? 'failure' : 'success';
  try {
    const r = await api<{ razorpay_order_id?: string; razorpay_payment_id?: string; razorpay_signature?: string; error?: { description: string } }>(
      '/api/billing/v1/payments/simulator/pay', { token, body: { orderId: f.get('orderId'), outcome, method: String(f.get('method') ?? 'upi') } });
    if (r.error) return go(`/care/pay/${invoiceId}`, { error: `${r.error.description} You can try again.` });
    await api('/api/billing/v1/payments/verify', { token, body: { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature } });
  } catch (e) {
    return go(`/care/pay/${invoiceId}`, { error: errorText(e) });
  }
  return go(`/care/pay/${invoiceId}`, { ok: 'Payment received.' });
}
