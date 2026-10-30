import type { LabOrder } from './lab';

export interface HomeAddress { line1: string; line2: string | null; landmark: string | null; city: string | null; pincode: string; phone: string }
export interface HomeVisit {
  id: string; status: string; orderId: string; orderNo: string; orderStatus: string; paymentStatus: string; total: number;
  slotAt: string; localTime: string; localDate: string; branch: { id: string; name: string }; patient: { id: string; name: string; mrn: string; gender: string | null };
  address: HomeAddress | null; phlebotomist: { id: string; name: string } | null; attempts: number; missedReason: string | null; overdue?: boolean;
  order?: LabOrder; log?: { status: string; by: string | null; note: string | null; at: string }[];
}
export interface Board {
  branch: { id: string; name: string }; date: string; visits: HomeVisit[];
  totals: { overdue?: number; unassigned: number; assigned: number; out: number; collected: number; missed: number };
  phlebotomists: { id: string; name: string; visits: number }[];
}
export const VISIT: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  UNASSIGNED: { label: 'to assign', tone: 'warning' }, ASSIGNED: { label: 'assigned', tone: 'neutral' }, EN_ROUTE: { label: 'on the way', tone: 'success' },
  ARRIVED: { label: 'at the patient', tone: 'success' }, COLLECTED: { label: 'collected', tone: 'success' }, HANDED_OVER: { label: 'at the lab', tone: 'success' },
  MISSED: { label: 'missed', tone: 'danger' }, CANCELLED: { label: 'cancelled', tone: 'neutral' },
};
export const addressLine = (a: HomeAddress | null) => (a ? [a.line1, a.line2, a.landmark, a.city, a.pincode].filter(Boolean).join(', ') : '');
