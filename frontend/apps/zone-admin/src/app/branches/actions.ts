'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/branches?${new URLSearchParams(q)}`);
const message = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');

export async function createBranch(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api('/api/tenant/v1/branches', {
      token,
      idempotencyKey: String(form.get('idempotencyKey')),
      body: { name: form.get('name'), city: form.get('city'), address: { pincode: form.get('pincode') || undefined } },
    });
  } catch (e) {
    return back({ error: message(e) });
  }
  return back({ ok: `Branch “${form.get('name')}” added` });
}

export async function setBranchActive(form: FormData) {
  const { accessToken: token } = await actionSession();
  const closing = form.get('active') === 'false';
  const upcoming = Number(form.get('upcoming') ?? 0);
  if (closing && upcoming > 0 && form.get('confirm') !== 'on') return back({ error: `Tick the box: ${upcoming} upcoming appointments at this branch will be cancelled` });
  try {
    await api(`/api/tenant/v1/branches/${form.get('id')}`, { token, method: 'PATCH', body: { active: form.get('active') === 'true', version: Number(form.get('version')) } });
  } catch (e) {
    return back({ error: message(e) });
  }
  return back({ ok: closing && upcoming ? `Branch deactivated: ${upcoming} upcoming appointment${upcoming === 1 ? '' : 's'} cancelled and refunded; patients are being told` : 'Branch updated' });
}
