import 'server-only';
import { api, ApiError } from '@mc/bff';

export interface Specialty { id: string; code: string; name: string; description: string | null; active: boolean; doctorCount: number }
export interface Branch { id: string; name: string; active: boolean }
export interface Doctor {
  id: string; userId: string | null; email: string; name: string; gender: string | null; registrationNo: string;
  qualifications: string[]; experienceYears: number | null; languages: string[]; bio: string | null; consultModes: string[];
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE'; version: number;
  specialties: { code: string; name: string; primary: boolean }[];
  branches: { id: string; name: string | null; fee: number; followupFee: number | null }[];
}

export const listSpecialties = (token: string) => api<Specialty[]>('/api/provider/v1/specialties', { token });
export const listBranches = (token: string) => api<Branch[]>('/api/tenant/v1/branches', { token });

export const errorText = (e: unknown) =>
  e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path || 'form'}: ${x.message}`).join('; ') || e.message) : 'Something went wrong';

const list = (v: FormDataEntryValue | null) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Turn the doctor form into the API body (shared by create and edit). */
export function doctorBody(form: FormData, branches: Branch[]) {
  const specialties = form.getAll('specialty').map(String);
  const primary = String(form.get('primarySpecialty') ?? '') || specialties[0];
  return {
    name: String(form.get('name') ?? ''),
    gender: (form.get('gender') as string) || null,
    qualifications: list(form.get('qualifications')),
    experienceYears: form.get('experienceYears') ? Number(form.get('experienceYears')) : null,
    languages: list(form.get('languages')).map((l) => l.toLowerCase()),
    bio: String(form.get('bio') ?? '').trim() || null,
    consultModes: form.getAll('mode').map(String),
    specialties: specialties.map((code) => ({ code, primary: code === primary })),
    branches: branches
      .filter((b) => form.get(`branch:${b.id}`) === 'on')
      .map((b) => ({ branchId: b.id, fee: Number(form.get(`fee:${b.id}`) || 0), followupFee: form.get(`followup:${b.id}`) ? Number(form.get(`followup:${b.id}`)) : null })),
  };
}
