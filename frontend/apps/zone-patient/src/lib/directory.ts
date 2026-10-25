import 'server-only';
import { api, ApiError } from '@mc/bff';

/** Public directory API (no sign-in needed; the hospital comes from the host). */
export interface PublicSpecialty { code: string; name: string; description: string | null; doctorCount: number }
export interface PublicDoctor {
  id: string; name: string; gender: string | null; qualifications: string[]; experienceYears: number | null; languages: string[];
  bio: string | null; photoUrl: string | null; consultModes: string[];
  specialties: { code: string; name: string; primary: boolean }[];
  branches: { id: string; name: string | null; fee: number }[];
  /** only from search-service: the doctor's earliest open slot */
  nextAvailableAt?: string | null;
}
export interface DoctorResults { items: PublicDoctor[]; nextCursor: string | null; source: 'search' | 'directory' }

export const getSpecialties = () => api<PublicSpecialty[]>('/api/provider/v1/public/specialties');
export const getBranches = () => api<{ id: string; name: string }[]>('/api/provider/v1/public/branches');

const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 1500);

/**
 * Search-service first (symptoms and synonyms, sorted by who is free soonest); if it is slow, down or not ready for
 * this hospital, the directory's own search answers instead. Cursors say which one made them ("s." = search), so
 * "More doctors" continues in the same place, and a search cursor that can't continue starts the directory over.
 */
export async function searchDoctors(q: URLSearchParams): Promise<DoctorResults> {
  const cursor = q.get('cursor');
  if (cursor === null || cursor.startsWith('s.')) {
    const p = new URLSearchParams(q);
    if (cursor) p.set('cursor', cursor.slice(2));
    try {
      const r = await api<{ items: PublicDoctor[]; nextCursor: string | null }>(`/api/search/v1/public/search/doctors?${p}`, { timeoutMs: SEARCH_TIMEOUT_MS });
      return { items: r.items, nextCursor: r.nextCursor ? `s.${r.nextCursor}` : null, source: 'search' };
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && !cursor) throw e; // a bad filter is bad for the directory too
    }
  }
  const p = new URLSearchParams(q);
  if (cursor?.startsWith('s.')) p.delete('cursor');
  const r = await api<{ items: PublicDoctor[]; nextCursor: string | null }>(`/api/provider/v1/public/doctors?${p}`);
  return { ...r, source: 'directory' };
}
export const getDoctor = (id: string) => api<PublicDoctor>(`/api/provider/v1/public/doctors/${encodeURIComponent(id)}`);

const LANGS: Record<string, string> = { en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati', pa: 'Punjabi', ur: 'Urdu' };
export const languageName = (code: string) => LANGS[code] ?? code;
export const LANGUAGE_OPTIONS = Object.entries(LANGS).map(([value, label]) => ({ value, label }));

export const feeRange = (d: PublicDoctor) => {
  const fees = d.branches.map((b) => b.fee);
  if (!fees.length) return '';
  const lo = Math.min(...fees), hi = Math.max(...fees);
  return lo === hi ? `₹${lo}` : `₹${lo}–₹${hi}`;
};
/** "Today, 4:30 PM" / "Tomorrow, 9:00 AM" / "Mon 27 Oct, 9:00 AM" (hospital time). */
export function nextAvailable(iso: string, tz = 'Asia/Kolkata') {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).format(at).toUpperCase();
  const today = day(new Date()), tomorrow = day(new Date(Date.now() + 86_400_000));
  const d = day(at) === today ? 'Today' : day(at) === tomorrow ? 'Tomorrow' : new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(at);
  return `${d}, ${time}`;
}
export const initials = (name: string) => name.replace(/^Dr\.?\s+/i, '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
