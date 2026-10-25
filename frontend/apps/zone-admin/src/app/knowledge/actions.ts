'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Admin → Assistant knowledge: add, edit, switch off and delete what the AI assistant answers from. */
const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/knowledge?${new URLSearchParams(q)}`);
const why = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path || 'form'}: ${x.message}`).join('; ') || e.message) : 'Could not save');
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function addArticle(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api('/api/assistant/v1/assistant/knowledge', { token, body: { source: text(f, 'source'), title: text(f, 'title'), body: text(f, 'body'), language: text(f, 'language') || 'en' } });
  } catch (e) {
    return back({ error: why(e) });
  }
  return back({ ok: `"${text(f, 'title')}" added: the assistant can answer from it now` });
}

export async function saveArticle(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/assistant/v1/assistant/knowledge/${encodeURIComponent(text(f, 'id'))}`, { token, method: 'PUT', body: { title: text(f, 'title'), body: text(f, 'body'), active: f.get('active') === 'on', version: Number(f.get('version')) } });
  } catch (e) {
    return back({ error: why(e) });
  }
  return back({ ok: `"${text(f, 'title')}" saved` });
}

export async function deleteArticle(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/assistant/v1/assistant/knowledge/${encodeURIComponent(text(f, 'id'))}`, { token, method: 'DELETE' });
  } catch (e) {
    return back({ error: why(e) });
  }
  return back({ ok: `"${text(f, 'title')}" deleted` });
}
