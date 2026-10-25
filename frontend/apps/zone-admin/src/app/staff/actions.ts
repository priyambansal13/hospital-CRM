'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/staff?${new URLSearchParams(q)}`);

export async function inviteStaff(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api('/api/iam/v1/staff/invites', {
      token,
      idempotencyKey: String(form.get('idempotencyKey')),
      body: { email: form.get('email'), name: form.get('name'), roles: [form.get('role')] },
    });
  } catch (e) {
    return back({ error: e instanceof ApiError ? e.message : 'Could not invite' });
  }
  return back({ ok: `Invited ${form.get('email')}` });
}
