'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Visit actions from "Today's queue"; each redirects back with a message (works without client JS). */
async function step(f: FormData, verb: 'start' | 'complete' | 'no-show', ok: (a: { patient: { name: string }; tokenNo: number | null }) => string) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    q = { ok: ok(await api(`/api/scheduling/v1/appointments/${encodeURIComponent(String(f.get('id')))}/${verb}`, { token, method: 'POST' })) };
  } catch (e) {
    q = { error: e instanceof ApiError ? e.message : 'Something went wrong' };
    // the note is open: the queue offers "Finish, sign later" for this visit
    if (e instanceof ApiError && e.code === 'NOTE_NOT_SIGNED') q.unsigned = String(f.get('id'));
  }
  redirect(`${await origin()}/doctor/queue?${new URLSearchParams(q)}`);
}

export async function startVisit(f: FormData) {
  return step(f, 'start', (a) => `Now seeing ${a.patient.name}${a.tokenNo ? ` (token ${a.tokenNo})` : ''}`);
}
export async function completeVisit(f: FormData) {
  return step(f, 'complete', (a) => `Visit with ${a.patient.name} completed`);
}
export async function markNoShow(f: FormData) {
  return step(f, 'no-show', (a) => `${a.patient.name} marked as no-show`);
}
