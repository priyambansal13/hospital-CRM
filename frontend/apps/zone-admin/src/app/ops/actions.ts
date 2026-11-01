'use server';
import { actionSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import { errorText } from '@/lib/directory';

const back = async (q: Record<string, string>, hash = '') => redirect(`${await origin()}/admin/ops?${new URLSearchParams(q)}${hash}`);

/** Ask the Ops agent; the answer is shown by its id. */
export async function ask(form: FormData) {
  const { accessToken: token } = await actionSession();
  let id: string;
  try {
    id = (await api<{ id: string }>('/api/assistant/v1/assistant/ops/ask', { token, body: { question: String(form.get('question') ?? '') } })).id;
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ q: id }, '#answer');
}

export async function rate(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/assistant/v1/assistant/ops/questions/${form.get('id')}/rating`, { token, body: { rating: Number(form.get('rating')) } });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ q: String(form.get('id')), ok: 'Thanks for the feedback' }, '#answer');
}

export async function remakeBrief(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/assistant/v1/assistant/ops/briefs/${form.get('branchId')}`, { token, method: 'POST' });
  } catch (e) {
    return back({ error: errorText(e) }, '#briefs');
  }
  return back({ ok: 'Today\'s brief was written again' }, '#briefs');
}

export async function saveWording(form: FormData) {
  const { accessToken: token } = await actionSession();
  const rule = String(form.get('rule'));
  const status = String(form.get('status'));
  try {
    await api(`/api/assistant/v1/assistant/ops/care-gaps/${rule}`, { token, method: 'PUT', body: { subject: String(form.get('subject') ?? '') || undefined, body: String(form.get('body') ?? '') || undefined, status, version: Number(form.get('version')) } });
  } catch (e) {
    return back({ error: errorText(e) }, '#care-gaps');
  }
  return back({ ok: status === 'APPROVED' ? 'Wording approved: reminders can go out' : status === 'OFF' ? 'Reminders switched off' : 'Saved as a draft' }, '#care-gaps');
}

export async function draftWording() {
  const { accessToken: token } = await actionSession();
  try {
    await api('/api/assistant/v1/assistant/ops/care-gaps/draft', { token, method: 'POST' });
  } catch (e) {
    return back({ error: errorText(e) }, '#care-gaps');
  }
  return back({ ok: 'Asked for new wording; drafts appear here when ready' }, '#care-gaps');
}

export async function runRule(form: FormData) {
  const { accessToken: token } = await actionSession();
  let r: { due: number; reminded: number };
  try {
    r = await api(`/api/assistant/v1/assistant/ops/care-gaps/${form.get('rule')}/run`, { token, method: 'POST' });
  } catch (e) {
    return back({ error: errorText(e) }, '#care-gaps');
  }
  return back({ ok: `${r.due} patients are due; ${r.reminded} reminded now (others were reminded in the last 90 days)` }, '#care-gaps');
}
