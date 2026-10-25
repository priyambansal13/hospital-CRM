import 'server-only';
import { toSVG } from 'bwip-js/node';

export interface Sample { id: string; barcode: string; sampleType: string; container: string | null; status: string; collectedAt: string | null; collectedBy: string | null; receivedAt: string | null; rejectedReason: string | null; replaces: string | null }
export interface LabOrder {
  id: string; orderNo: string; status: string; paymentMode: string | null; paymentStatus: string; total: number;
  patient: { id: string; name: string; mrn: string; dob: string | null; gender: string | null };
  orderedBy: { name: string } | null; note: string | null; branch: { id: string; name: string } | null;
  slotAt: string | null; localDate: string | null; localTime: string | null; preparation: string | null;
  lines: { kind: string; code: string; name: string; price: number }[];
  tests: { code: string; name: string; sampleType: string; status: string; turnaroundHours: number }[];
  samples: Sample[];
  collectedAt?: string | null; dueAt?: string | null; overdue?: boolean;
  collectionType?: 'AT_LAB' | 'HOME'; homeVisit?: { id: string; status: string; phlebotomistName: string | null } | null;
}
export interface Worklist { branch: { id: string; name: string }; date: string; totals: Record<string, number>; orders: LabOrder[] }

/** Code 128 label as inline SVG (scanners read it; text printed underneath). */
export const barcodeSvg = (text: string) => toSVG({ bcid: 'code128', text, height: 9, includetext: true, textxalign: 'center' });

export const age = (dob: string | null) => {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  const n = new Date();
  let y = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) y--;
  return y;
};

export const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  BOOKED: { label: 'to collect', tone: 'warning' }, SAMPLE_COLLECTED: { label: 'collected', tone: 'success' }, IN_LAB: { label: 'in lab', tone: 'success' },
  SAMPLE_REJECTED: { label: 'recollect', tone: 'danger' }, CANCELLED: { label: 'cancelled', tone: 'neutral' },
  RESULTS_ENTERED: { label: 'to verify', tone: 'warning' }, REPORT_PUBLISHED: { label: 'report published', tone: 'success' },
};

export interface Sheet {
  order: LabOrder; collectedAt: string | null; dueAt: string | null; overdue: boolean;
  tests: { itemId: string; code: string; name: string; status: string; parameters: { parameter: string; unit: string | null; refLow: number | null; refHigh: number | null; value: string | null; flag: string | null; enteredBy: string | null; critical: boolean; acknowledged: string | null }[] }[];
  reports: { id: string; version: number; documentId: string | null; verifiedBy: string; verifiedAt: string; superseded: boolean; amendmentReason: string | null; abnormal: number; critical: number; verifyCode: string }[];
}
export const FLAG: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  NORMAL: { label: 'normal', tone: 'success' }, LOW: { label: 'low', tone: 'warning' }, HIGH: { label: 'high', tone: 'warning' },
  CRITICAL_LOW: { label: 'CRITICAL low', tone: 'danger' }, CRITICAL_HIGH: { label: 'CRITICAL high', tone: 'danger' }, ABNORMAL: { label: 'abnormal', tone: 'warning' },
};
export const refRange = (lo: number | null, hi: number | null) => (lo != null && hi != null ? `${lo}–${hi}` : lo != null ? `> ${lo}` : hi != null ? `< ${hi}` : '');
