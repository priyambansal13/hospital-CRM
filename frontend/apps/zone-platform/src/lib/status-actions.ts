'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const istToIso = (v: string) => (v ? new Date(`${v}:00+05:30`).toISOString() : null);
const message = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : 'Something went wrong');

async function run(fn: (token: string) => Promise<unknown>, ok: string) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try { await fn(token); q = { ok }; } catch (e) { q = { error: message(e) }; }
  return redirect(`${await origin()}/platform/status?${new URLSearchParams(q)}`);
}

/** A new incident, or planned maintenance (SCHEDULED, with a start and end in India time). */
export async function postIncident(f: FormData) {
  const planned = str(f, 'impact') === 'MAINTENANCE';
  return run((token) => api('/api/tenant/v1/platform/status/incidents', { token, body: {
    title: str(f, 'title'), impact: str(f, 'impact'), components: f.getAll('components').map(String), message: str(f, 'message'),
    status: planned ? 'SCHEDULED' : 'INVESTIGATING', startsAt: istToIso(str(f, 'startsAt')), endsAt: istToIso(str(f, 'endsAt')),
  } }), 'Posted on the status page');
}

export async function postUpdate(f: FormData) {
  return run((token) => api(`/api/tenant/v1/platform/status/incidents/${encodeURIComponent(str(f, 'id'))}/updates`, { token, body: { status: str(f, 'status'), message: str(f, 'message') } }), 'Update posted');
}
