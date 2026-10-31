'use server';
import { actionSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import { errorText } from '@/lib/directory';
import { type Form, keyOf, parseQuestions } from './lib';

const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/custom-fields?${new URLSearchParams(q)}`);
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const opts = (f: FormData) => str(f, 'options').split(',').map((o) => o.trim()).filter(Boolean);

export async function addField(form: FormData) {
  const { accessToken: token } = await actionSession();
  const label = str(form, 'label');
  try {
    await api('/api/integration/v1/custom-fields', { token, body: { entity: str(form, 'entity'), key: keyOf(label), label, type: str(form, 'type'), options: opts(form), required: form.get('required') === 'on', help: str(form, 'help') || null } });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: `Added "${label}"` });
}

export async function updateField(form: FormData) {
  const { accessToken: token } = await actionSession();
  const body: Record<string, unknown> = { version: Number(form.get('version')) };
  if (form.has('active')) body.active = form.get('active') === 'true';
  else Object.assign(body, { label: str(form, 'label'), required: form.get('required') === 'on', help: str(form, 'help') || null, ...(form.has('options') ? { options: opts(form) } : {}) });
  try {
    await api(`/api/integration/v1/custom-fields/${form.get('id')}`, { token, method: 'PATCH', body });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: 'Saved' });
}

export async function saveForm(form: FormData) {
  const { accessToken: token } = await actionSession();
  const id = str(form, 'id');
  const existing = id ? (await api<Form[]>('/api/integration/v1/forms', { token })).find((f) => f.id === id)?.fields ?? [] : [];
  const { fields, error } = parseQuestions(str(form, 'questions'), existing);
  if (error) return back({ error, ...(id ? { form: id } : {}) });
  try {
    if (id) await api(`/api/integration/v1/forms/${id}`, { token, method: 'PATCH', body: { name: str(form, 'name'), intro: str(form, 'intro') || null, fields, version: Number(form.get('version')) } });
    else await api('/api/integration/v1/forms', { token, body: { name: str(form, 'name'), specialtyCode: str(form, 'specialtyCode') || null, intro: str(form, 'intro') || null, fields } });
  } catch (e) {
    return back({ error: errorText(e), ...(id ? { form: id } : {}) });
  }
  return back({ ok: `Saved the form "${str(form, 'name')}"` });
}

export async function toggleForm(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/integration/v1/forms/${form.get('id')}`, { token, method: 'PATCH', body: { active: form.get('active') === 'true', version: Number(form.get('version')) } });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: 'Updated' });
}
