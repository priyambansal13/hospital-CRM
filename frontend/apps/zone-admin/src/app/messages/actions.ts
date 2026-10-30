'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

export async function saveTemplate(f: FormData) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    await api(`/api/notification/v1/notification-templates/${f.get('id')}`, { token, method: 'PUT', body: { subject: f.get('subject') ?? null, body: f.get('body'), active: f.get('active') === 'on', ...(f.has('providerTemplateId') ? { providerTemplateId: String(f.get('providerTemplateId')).trim() || null, dltTemplateId: String(f.get('dltTemplateId')).trim() || null } : {}) } });
    q = { ok: 'Template saved' };
  } catch (e) {
    q = { error: e instanceof ApiError ? e.message : 'Could not save' };
  }
  redirect(`${await origin()}/admin/messages?${new URLSearchParams({ ...q, tab: 'templates' })}#t-${f.get('id')}`);
}
