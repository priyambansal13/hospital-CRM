'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** The copilot panel's actions (Phase 24): make the pre-visit summary, rate it. Each comes back to the consult page. */
const back = async (path: string, q: Record<string, string>) => redirect(`${await origin()}${path.startsWith('/doctor/') ? path : '/doctor/queue'}?${new URLSearchParams(q)}`);
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function makeSummary(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/assistant/v1/assistant/copilot/appointments/${encodeURIComponent(str(f, 'appointmentId'))}/summary`, { token, method: 'POST' });
  } catch (e) {
    return back(str(f, 'back'), { error: e instanceof ApiError ? e.message : 'The summary could not be made just now.' });
  }
  return back(str(f, 'back'), { ok: 'Summary ready: check the cited records before relying on it.' });
}

export async function rateSummary(f: FormData) {
  const { accessToken: token } = await actionSession();
  const rating = str(f, 'rating') === '1' ? 1 : -1;
  try {
    await api(`/api/assistant/v1/assistant/copilot/drafts/${encodeURIComponent(str(f, 'draftId'))}/feedback`, {
      token, body: { rating, reason: rating === -1 ? str(f, 'reason') || 'OTHER' : null, comment: str(f, 'comment') || null },
    });
  } catch (e) {
    return back(str(f, 'back'), { error: e instanceof ApiError ? e.message : 'Feedback not saved.' });
  }
  return back(str(f, 'back'), { ok: 'Thanks: your feedback helps improve the summaries.' });
}
