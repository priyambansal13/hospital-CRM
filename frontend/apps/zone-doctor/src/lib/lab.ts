export interface CriticalAlert { id: string; orderId: string; orderNo: string; patient: { id: string; name: string; mrn: string }; test: string; parameter: string; value: string; unit: string | null; refLow: number | null; refHigh: number | null; flag: string; createdAt: string; acknowledgedAt: string | null; acknowledgedBy: string | null }
export interface OrderedTest { id: string; orderNo: string; status: string; patient: { id: string; name: string; mrn: string }; tests: string; createdAt: string; slotAt: string | null; report: { version: number; abnormal_count: number; critical_count: number; verified_at: string } | null }
export interface ResultSheet {
  order: { id: string; orderNo: string; status: string; patient: { id: string; name: string; mrn: string } };
  tests: { itemId: string; name: string; parameters: { parameter: string; unit: string | null; refLow: number | null; refHigh: number | null; value: string | null; flag: string | null; critical: boolean; acknowledged: string | null }[] }[];
  reports: { version: number; verifiedBy: string; verifiedAt: string; superseded: boolean; amendmentReason: string | null }[];
}
export const FLAG: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  NORMAL: { label: 'normal', tone: 'success' }, LOW: { label: 'L', tone: 'warning' }, HIGH: { label: 'H', tone: 'warning' },
  CRITICAL_LOW: { label: 'CRITICAL L', tone: 'danger' }, CRITICAL_HIGH: { label: 'CRITICAL H', tone: 'danger' }, ABNORMAL: { label: 'abnormal', tone: 'warning' },
};
export const STATUS: Record<string, string> = {
  AWAITING_BOOKING: 'patient to book', PENDING_PAYMENT: 'awaiting payment', BOOKED: 'booked', SAMPLE_COLLECTED: 'sample collected', IN_LAB: 'in the lab',
  SAMPLE_REJECTED: 'recollection needed', RESULTS_ENTERED: 'awaiting verification', REPORT_PUBLISHED: 'report ready', CANCELLED: 'cancelled', EXPIRED: 'expired',
};
export const refRange = (lo: number | null, hi: number | null) => (lo != null && hi != null ? `${lo}–${hi}` : lo != null ? `> ${lo}` : hi != null ? `< ${hi}` : '');
export const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : '—');
