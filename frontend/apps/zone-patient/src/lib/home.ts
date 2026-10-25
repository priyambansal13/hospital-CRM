import 'server-only';
import { api } from '@mc/bff';

export interface HomeCheck { serviceable: boolean; pincode: string; branch: { id: string; name: string } | null; area: string | null; fee: number | null }
export const homeCheck = (pincode: string) => api<HomeCheck>(`/api/diagnostics/v1/public/home-collection/check?pincode=${encodeURIComponent(pincode)}`);
export const homeSlots = (pincode: string, date: string) => api<{ slots: { slotAt: string; localTime: string; left: number }[]; fee: number }>(`/api/diagnostics/v1/public/home-collection/slots?pincode=${encodeURIComponent(pincode)}&date=${date}`);
/** What the patient sees about a home visit. */
export const VISIT_TEXT: Record<string, string> = {
  UNASSIGNED: 'We will tell you who is coming', ASSIGNED: 'is coming', EN_ROUTE: 'is on the way', ARRIVED: 'is with you',
  COLLECTED: 'Samples collected', HANDED_OVER: 'Samples at the lab', MISSED: 'We missed you', CANCELLED: 'Cancelled',
};
