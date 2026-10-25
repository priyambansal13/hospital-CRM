import 'server-only';
import { api } from '@mc/bff';

export interface CatalogTest { id: string; code: string; name: string; category: string; sampleType: string; preparation: string | null; fastingHours: number | null; turnaroundHours: number; price: number }
export interface CatalogPackage { id: string; code: string; name: string; description: string | null; price: number; worth: number; preparation: string | null; tests: { code: string; name: string }[] }
export interface Catalog { packages: CatalogPackage[]; tests: CatalogTest[] }
export interface LabOrder {
  id: string; orderNo: string; status: string; paymentMode: string | null; paymentStatus: string; invoiceId: string | null; total: number;
  patient: { id: string; name: string }; orderedBy: { name: string } | null; branch: { name: string } | null;
  slotAt: string | null; localDate: string | null; localTime: string | null; holdExpiresAt: string | null; preparation: string | null;
  lines: { kind: string; name: string; price: number }[]; samples: { barcode: string; sampleType: string; status: string }[];
  collectionType?: 'AT_LAB' | 'HOME'; homeAddress?: { line1: string; line2: string | null; landmark: string | null; city: string | null; pincode: string; phone: string } | null;
  homeVisit?: { id: string; status: string; phlebotomistName: string | null; attempts: number; missedReason: string | null } | null;
}

const listCatalog = (q?: string) => api<Catalog>(`/api/diagnostics/v1/public/lab-catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`);
/** With a search term: search-service first ("sugar test" → HbA1c), the lab's own name match if it is unavailable. */
export async function catalog(q?: string): Promise<Catalog> {
  if (!q?.trim()) return listCatalog();
  try {
    return await api<Catalog>(`/api/search/v1/public/search/tests?q=${encodeURIComponent(q)}`, { timeoutMs: Number(process.env.SEARCH_TIMEOUT_MS ?? 1500) });
  } catch {
    return listCatalog(q);
  }
}
export const labBranches = () => api<{ id: string; name: string }[]>('/api/diagnostics/v1/public/lab-branches');
export const labSlots = (branchId: string, date: string) => api<{ slots: { slotAt: string; localTime: string; left: number }[] }>(`/api/diagnostics/v1/public/lab-slots?branchId=${branchId}&date=${date}`);

export const LAB_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  AWAITING_BOOKING: { label: 'Pick a time', tone: 'warning' }, PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'warning' }, BOOKED: { label: 'Booked', tone: 'success' },
  SAMPLE_COLLECTED: { label: 'Sample collected', tone: 'success' }, IN_LAB: { label: 'Being tested', tone: 'success' }, SAMPLE_REJECTED: { label: 'New sample needed', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' }, EXPIRED: { label: 'Not paid in time', tone: 'neutral' },
  RESULTS_ENTERED: { label: 'Being checked', tone: 'success' }, REPORT_PUBLISHED: { label: 'Report ready', tone: 'success' },
};

export interface ResultSheet {
  order: LabOrder;
  tests: { itemId: string; name: string; parameters: { parameter: string; unit: string | null; refLow: number | null; refHigh: number | null; value: string | null; flag: string | null }[] }[];
  reports: { version: number; verifiedBy: string; verifiedAt: string; superseded: boolean; amendmentReason: string | null }[];
}
/** Plain-language flags for patients (the doctor explains what they mean). */
export const FLAG: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  NORMAL: { label: 'in range', tone: 'success' }, LOW: { label: 'below range', tone: 'warning' }, HIGH: { label: 'above range', tone: 'warning' },
  CRITICAL_LOW: { label: 'far below range', tone: 'danger' }, CRITICAL_HIGH: { label: 'far above range', tone: 'danger' }, ABNORMAL: { label: 'not normal', tone: 'warning' },
};
export const refRange = (lo: number | null, hi: number | null) => (lo != null && hi != null ? `${lo}–${hi}` : lo != null ? `> ${lo}` : hi != null ? `< ${hi}` : '');
