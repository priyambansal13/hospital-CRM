'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Sales follows up a demo request: its status and a note. */
export async function updateLead(f: FormData) {
  const id = String(f.get('id'));
  const note = String(f.get('note') ?? '').trim();
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    await api(`/api/tenant/v1/platform/growth/leads/${encodeURIComponent(id)}`, { token, method: 'PATCH', body: { status: String(f.get('status')), note: note || null } });
    q = { ok: 'Demo request updated' };
  } catch (e) {
    q = { error: e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : 'Something went wrong' };
  }
  return redirect(`${await origin()}/platform/growth?${new URLSearchParams(q)}#leads`);
}
