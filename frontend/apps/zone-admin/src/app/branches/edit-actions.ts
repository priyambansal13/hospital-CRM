'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** E-4 branch details (with the time zone) and E-5 home visit times. */
const go = async (path: string, q: Record<string, string>) => redirect(`${await origin()}${path}?${new URLSearchParams(q)}`);
const message = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');

export async function saveBranch(f: FormData) {
  const { accessToken: token } = await actionSession();
  const id = String(f.get('id'));
  try {
    await api(`/api/tenant/v1/branches/${encodeURIComponent(id)}`, { token, method: 'PATCH', body: {
      name: f.get('name'), city: f.get('city'), timezone: f.get('timezone'), version: Number(f.get('version')),
      address: { line1: String(f.get('line1') ?? '').trim() || undefined, pincode: String(f.get('pincode') ?? '').trim() || undefined },
    } });
  } catch (e) {
    return go(`/admin/branches/${id}`, { error: message(e) });
  }
  return go('/admin/branches', { ok: `${f.get('name')} saved` });
}

export async function saveHomeWindows(f: FormData) {
  const { accessToken: token } = await actionSession();
  const branchId = String(f.get('branchId'));
  const rows = Number(f.get('rows'));
  const windows = [];
  for (let i = 0; i < rows; i++) {
    const day = Number(f.get(`day${i}`));
    const start = String(f.get(`start${i}`) ?? '');
    const end = String(f.get(`end${i}`) ?? '');
    if (!day || !start || !end) continue;
    windows.push({ day, start, end, slotMinutes: Number(f.get(`slot${i}`) ?? 30), capacity: Number(f.get(`cap${i}`) ?? 2) });
  }
  try {
    await api(`/api/diagnostics/v1/admin/home-windows/${encodeURIComponent(branchId)}`, { token, method: 'PUT', body: { windows } });
  } catch (e) {
    return go('/admin/home-collection', { error: message(e) });
  }
  return go('/admin/home-collection', { ok: `Home visit times saved (${windows.length} window${windows.length === 1 ? '' : 's'})` });
}
