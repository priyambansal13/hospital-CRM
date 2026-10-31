import 'server-only';
import { api, ApiError } from '@mc/bff';

export interface SlotView { slotId: string; startsAt: string; localTime: string; mode: string; branch: { id: string; name: string }; fee: number | null; membersOnly?: boolean }
export interface SlotDays { doctor: { id: string; name: string }; days: { date: string; slots: SlotView[] }[] }
export interface SlotDetail { slotId: string; available: boolean; startsAt: string; localDate: string; localTime: string; mode: string; doctor: { id: string; name: string }; branch: { id: string; name: string }; fee: number | null; membersOnly?: boolean }
export interface PatientRecord { id: string; mrn: string; fullName: string; dob: string; gender: string | null; relation: string; isSelf: boolean; email: string | null; version: number }
export interface Appointment {
  id: string; appointmentNo: string; status: string; patient: { id: string; name: string; mrn: string }; doctor: { id: string; name: string };
  branch: { id: string; name: string }; startsAt: string; endsAt: string; localDate: string; localTime: string; mode: string; reason: string | null;
  fee: number | null; paymentMode: string; rescheduleCount: number; cancelReason: string | null; memberBenefit?: string | null;
  paymentStatus: string; invoiceId: string | null; holdExpiresAt: string | null;
}
export interface MyAppointments { upcoming: Appointment[]; past: Appointment[]; policy: { cancelWindowHours: number; maxReschedules: number } }

export const publicSlots = (doctorId: string) => api<SlotDays>(`/api/scheduling/v1/public/doctors/${encodeURIComponent(doctorId)}/slots?days=14`);
export const slotDetail = (slotId: string) => api<SlotDetail>(`/api/scheduling/v1/public/slots/${encodeURIComponent(slotId)}`);
export const myPatients = (token: string) => api<PatientRecord[]>('/api/patient/v1/me/patients', { token });
export const myAppointments = (token: string) => api<MyAppointments>('/api/scheduling/v1/me/appointments', { token });

export const errorText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path || 'form'}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');

export const fmtDay = (iso: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
export const fmtTime = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
export const RELATIONS = [{ value: 'CHILD', label: 'Child' }, { value: 'SPOUSE', label: 'Spouse' }, { value: 'PARENT', label: 'Parent' }, { value: 'SIBLING', label: 'Sibling' }, { value: 'OTHER', label: 'Other' }];
