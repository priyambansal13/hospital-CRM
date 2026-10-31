'use server';
import { actionSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { errorText } from '@/lib/directory';

const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/integrations?${new URLSearchParams(q)}`);
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
/**
 * A new secret or key is shown once: handed to the page in a short-lived httpOnly cookie (never in the URL, which
 * ends up in history and logs). It lapses after a minute.
 */
const once = async (label: string, value: string) => {
  (await cookies()).set('mc-once', JSON.stringify({ label, value }), { httpOnly: true, sameSite: 'strict', maxAge: 60, path: '/admin/integrations', secure: process.env.NODE_ENV === 'production' });
  return {};
};

export async function addEndpoint(form: FormData) {
  const { accessToken: token } = await actionSession();
  const kind = str(form, 'kind') === 'LIS' ? 'LIS' : 'WEBHOOK';
  let r: { secret: string; name: string };
  try {
    r = await api('/api/integration/v1/integrations/endpoints', { token, body: kind === 'LIS' ? { kind, name: str(form, 'name'), url: str(form, 'url') } : { kind, name: str(form, 'name'), url: str(form, 'url'), events: form.getAll('events').map(String) } });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: `Added ${r.name}. Copy the signing secret now: it is not shown again.`, ...await once(`Signing secret for ${r.name}`, r.secret) });
}

export async function endpointAction(form: FormData) {
  const { accessToken: token } = await actionSession();
  const id = str(form, 'id');
  const what = str(form, 'what');
  try {
    if (what === 'test') {
      const d = await api<{ status: string; lastError: string | null }>(`/api/integration/v1/integrations/endpoints/${id}/test`, { token, method: 'POST' });
      return back(d.status === 'DELIVERED' ? { ok: 'Test delivered' } : { error: `Test not delivered: ${d.lastError ?? d.status}` });
    }
    const r = await api<{ secret?: string; name: string }>(`/api/integration/v1/integrations/endpoints/${id}`, { token, method: 'PATCH', body: { version: Number(form.get('version')), ...(what === 'rotate' ? { rotateSecret: true } : { active: what === 'on' }) } });
    if (r.secret) return back({ ok: 'New secret: update your receiver now (the old one stops working).', ...await once(`New signing secret for ${r.name}`, r.secret) });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: 'Updated' });
}

export async function retryDelivery(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/integration/v1/integrations/deliveries/${str(form, 'id')}/retry`, { token, method: 'POST' });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: 'Queued again' });
}

export async function addKey(form: FormData) {
  const { accessToken: token } = await actionSession();
  let r: { key: string; name: string };
  try {
    r = await api('/api/integration/v1/integrations/api-keys', { token, body: { name: str(form, 'name'), scopes: form.getAll('scopes').map(String) } });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: `Created ${r.name}. Copy the key now: it is not shown again.`, ...await once(`API key ${r.name}`, r.key) });
}

export async function revokeKey(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/integration/v1/integrations/api-keys/${str(form, 'id')}/revoke`, { token, method: 'POST' });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: 'Revoked' });
}
