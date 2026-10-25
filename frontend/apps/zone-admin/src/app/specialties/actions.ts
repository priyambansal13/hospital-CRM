'use server';
import { actionSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import { errorText } from '@/lib/directory';

const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/specialties?${new URLSearchParams(q)}`);

export async function addSpecialty(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api('/api/provider/v1/specialties', { token, body: { name: form.get('name'), description: String(form.get('description') ?? '') || null } });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: `Added ${form.get('name')}` });
}

export async function toggleSpecialty(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/provider/v1/specialties/${form.get('id')}`, { token, method: 'PATCH', body: { active: form.get('active') === 'true' } });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: 'Updated' });
}
