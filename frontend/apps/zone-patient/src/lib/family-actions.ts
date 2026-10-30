'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** E-6: edit a family member, leave a waitlist. Each returns to the page with a message. */
const go = async (path: string, q: Record<string, string>) => redirect(`${await origin()}${path}?${new URLSearchParams(q)}`);
const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : 'Something went wrong');

export async function updateDependent(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/patient/v1/me/dependents/${encodeURIComponent(String(f.get('id')))}`, { token, method: 'PATCH', body: {
      version: Number(f.get('version')), fullName: String(f.get('fullName') ?? '').trim(), dob: f.get('dob'), relation: f.get('relation'),
    } });
  } catch (e) {
    return go('/care/profile', { error: msg(e) });
  }
  return go('/care/profile', { ok: `${f.get('fullName')} updated` });
}

export async function leaveWaitlist(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/scheduling/v1/waitlist/${encodeURIComponent(String(f.get('id')))}`, { token, method: 'DELETE' });
  } catch (e) {
    return go('/care/appointments', { error: msg(e) });
  }
  return go('/care/appointments', { ok: 'Removed from the waitlist' });
}
