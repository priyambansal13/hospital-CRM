import 'server-only';
import { api } from '@mc/bff';
import { branchesFor, type Capabilities } from '@mc/features';

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

/** Active branches the person works at (review B-1), and the one picked (?branch=, else their own / the first). */
export async function branches(token: string, picked: string | undefined, caps: Capabilities, permission = 'appointment:checkin:branch') {
  const all = branchesFor(caps, permission, (await api<Branch[]>('/api/tenant/v1/branches', { token })).filter((b) => b.active));
  return { all, current: all.find((b) => b.id === picked) ?? all[0] };
}

export const age = (dob: string) => {
  const d = new Date(`${dob}T00:00:00Z`);
  const n = new Date();
  let y = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) y--;
  return y;
};

/** Waiting chat requests (alert banner), when the hospital has the assistant and the person handles them. */
export async function chatSummary(token: string, caps: Capabilities) {
  if (!caps.modules.includes('ai') || !caps.permissions.includes('assistant_handoff:manage:branch')) return null;
  return api<{ open: number; emergency: number; oldestMinutes: number | null }>('/api/assistant/v1/assistant/handoffs/summary', { token }).catch(() => null);
}

export interface TriageSummary { priority: 'ROUTINE' | 'URGENT' | 'EMERGENCY'; recordedAt: string }

/** Which of these appointments a nurse has triaged, and how urgent (no clinical values). */
export async function triageSummary(token: string, caps: Capabilities, ids: string[]): Promise<Record<string, TriageSummary>> {
  if (!ids.length || !caps.modules.includes('emr') || !caps.permissions.includes('vitals:record:branch')) return {};
  return api<Record<string, TriageSummary>>(`/api/records/v1/triage-summary?appointmentIds=${ids.join(',')}`, { token }).catch(() => ({}));
}
