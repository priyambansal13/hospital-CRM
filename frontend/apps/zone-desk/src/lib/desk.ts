import 'server-only';
import { api } from '@mc/bff';

export interface Branch { id: string; name: string; active: boolean }
export interface Appt {
  id: string; appointmentNo: string; status: string; tokenNo: number | null; source: string; mode: string;
  patient: { id: string; name: string; mrn: string }; doctor: { id: string; name: string }; branch: { id: string; name: string };
  localDate: string; localTime: string; startsAt: string; reason: string | null; checkedInAt: string | null;
  fee: number | null; paymentMode: string; paymentStatus: string;
}
export interface Board {
  branch: { id: string; name: string }; date: string;
  totals: { booked: number; waiting: number; inProgress: number; completed: number; noShow: number };
  doctors: { id: string; name: string; status: string; appointments: Appt[] }[];
}
export interface Patient { id: string; mrn: string; fullName: string; dob: string; gender: string | null; relation: string; isSelf: boolean; phone: string | null; guardianName: string | null }

export const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  CONFIRMED: { label: 'booked', tone: 'neutral' },
  CHECKED_IN: { label: 'waiting', tone: 'warning' },
  IN_PROGRESS: { label: 'with doctor', tone: 'success' },
  COMPLETED: { label: 'done', tone: 'success' },
  NO_SHOW: { label: 'no-show', tone: 'danger' },
  CANCELLED: { label: 'cancelled', tone: 'danger' },
};

/** Active branches, and the one picked (?branch=, else the first). */
export async function branches(token: string, picked?: string) {
  const all = (await api<Branch[]>('/api/tenant/v1/branches', { token })).filter((b) => b.active);
  return { all, current: all.find((b) => b.id === picked) ?? all[0] };
}

export const age = (dob: string) => {
  const d = new Date(`${dob}T00:00:00Z`);
  const n = new Date();
  let y = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) y--;
  return y;
};
