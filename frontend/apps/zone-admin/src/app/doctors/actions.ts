'use server';
import { actionSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import { doctorBody, errorText, listBranches } from '@/lib/directory';

const go = async (path: string, q: Record<string, string>) => redirect(`${await origin()}/admin${path}?${new URLSearchParams(q)}`);

export async function createDoctor(form: FormData) {
  const { accessToken: token } = await actionSession();
  let id: string;
  try {
    const branches = await listBranches(token);
    const d = await api<{ id: string }>('/api/provider/v1/doctors', {
      token, idempotencyKey: String(form.get('idempotencyKey')),
      body: { ...doctorBody(form, branches), email: form.get('email'), registrationNo: form.get('registrationNo') },
    });
    id = d.id;
  } catch (e) {
    return go('/doctors', { error: errorText(e) });
  }
  return go(`/doctors/${id}`, { ok: 'Doctor added as a draft. They can sign in with the invite; publish the profile when it is ready.' });
}

export async function updateDoctor(form: FormData) {
  const { accessToken: token } = await actionSession();
  const id = String(form.get('id'));
  try {
    const branches = await listBranches(token);
    await api(`/api/provider/v1/doctors/${id}`, { token, method: 'PATCH', body: { ...doctorBody(form, branches), version: Number(form.get('version')) } });
  } catch (e) {
    return go(`/doctors/${id}`, { error: errorText(e) });
  }
  return go(`/doctors/${id}`, { ok: 'Saved' });
}

export async function setDoctorStatus(form: FormData) {
  const { accessToken: token } = await actionSession();
  const id = String(form.get('id'));
  const status = String(form.get('status'));
  const back = String(form.get('back') ?? '/doctors');
  const upcoming = Number(form.get('upcoming') ?? 0);
  if (status === 'INACTIVE' && upcoming > 0 && form.get('confirm') !== 'on') return go(back, { error: `Tick the box: ${upcoming} upcoming appointments will be cancelled` });
  try {
    await api(`/api/provider/v1/doctors/${id}/status`, { token, body: { status } });
  } catch (e) {
    return go(back, { error: errorText(e) });
  }
  return go(back, { ok: status === 'ACTIVE' ? 'Published: patients can now find this doctor' : `Unpublished${upcoming ? `: ${upcoming} upcoming appointment${upcoming === 1 ? '' : 's'} cancelled and refunded; patients are being told` : ''}` });
}
