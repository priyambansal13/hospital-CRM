'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const back = async (q: Record<string, string>, path = '/admin/staff') => redirect(`${await origin()}${path}?${new URLSearchParams(q)}`);
const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const branchOf = (form: FormData) => (String(form.get('branchId') ?? '') || null);

export async function inviteStaff(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api('/api/iam/v1/staff/invites', {
      token,
      idempotencyKey: String(form.get('idempotencyKey')),
      body: { email: form.get('email'), name: form.get('name'), roles: [form.get('role')], branchId: branchOf(form) },
    });
  } catch (e) {
    return back({ error: msg(e, 'Could not invite') });
  }
  return back({ ok: `Invited ${form.get('email')}` });
}

/** One staff member's page: roles (per branch), deactivate / reactivate, resend the invite, reset sign-in (reviews B-1, B-2). */
export async function staffAction(form: FormData) {
  const { accessToken: token } = await actionSession();
  const userId = String(form.get('userId'));
  const page = `/admin/staff/${userId}`;
  const op = String(form.get('op'));
  let ok = '';
  try {
    switch (op) {
      case 'grant':
        await api(`/api/entitlement/v1/users/${userId}/roles`, { token, body: { roleCode: form.get('role'), branchId: branchOf(form) } });
        ok = 'Role given';
        break;
      case 'revoke':
        await api(`/api/entitlement/v1/users/${userId}/roles/${encodeURIComponent(String(form.get('role')))}`, { token, method: 'DELETE' });
        ok = 'Role removed';
        break;
      case 'deactivate':
        if (form.get('confirm') !== 'yes') return back({ error: 'Tick the box to confirm' }, page);
        await api(`/api/iam/v1/staff/${userId}/deactivate`, { token, body: { reason: form.get('reason') } });
        ok = 'Deactivated: they are signed out and can no longer sign in here';
        break;
      case 'reactivate':
        await api(`/api/iam/v1/staff/${userId}/reactivate`, { token, body: {} });
        ok = 'Reactivated: give them their roles again';
        break;
      case 'resend':
        await api(`/api/iam/v1/staff/${userId}/resend-invite`, { token, body: {} });
        ok = 'Invite e-mail sent again';
        break;
      case 'reset':
        await api(`/api/iam/v1/staff/${userId}/reset-sign-in`, { token, body: { password: form.get('password') === 'on', authenticator: form.get('authenticator') === 'on' } });
        ok = 'Sent: they will get an e-mail to set things up again; their sessions have ended';
        break;
      default:
        return back({ error: 'Unknown action' }, page);
    }
  } catch (e) {
    return back({ error: msg(e, 'That did not work') }, page);
  }
  return back({ ok }, page);
}
