'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/lab-catalog?${new URLSearchParams(q)}`);

export async function saveTest(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/diagnostics/v1/admin/lab-tests/${encodeURIComponent(String(f.get('id')))}`, { token, method: 'PATCH', body: { price: Number(f.get('price')), active: f.get('active') === 'on', preparation: String(f.get('preparation') ?? '').trim() || null } });
  } catch (e) {
    return back({ error: e instanceof ApiError ? e.message : 'Could not save' });
  }
  return back({ ok: `${f.get('name')} saved` });
}

export async function savePackage(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/diagnostics/v1/admin/lab-packages/${encodeURIComponent(String(f.get('id')))}`, { token, method: 'PATCH', body: { price: Number(f.get('price')), active: f.get('active') === 'on' } });
  } catch (e) {
    return back({ error: e instanceof ApiError ? e.message : 'Could not save' });
  }
  return back({ ok: `${f.get('name')} saved` });
}
