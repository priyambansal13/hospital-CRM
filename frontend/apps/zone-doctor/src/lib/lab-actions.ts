'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** "I have seen this critical value and am acting on it." */
export async function acknowledgeCritical(f: FormData) {
  const { accessToken: token } = await actionSession();
  const back = String(f.get('back') ?? '/doctor/lab-results');
  let q: Record<string, string>;
  try {
    await api(`/api/diagnostics/v1/doctor/critical-alerts/${encodeURIComponent(String(f.get('alertId')))}/ack`, { token, method: 'POST' });
    q = { ok: 'Critical value acknowledged' };
  } catch (e) {
    q = { error: e instanceof ApiError ? e.message : 'Something went wrong' };
  }
  redirect(`${await origin()}${back.startsWith('/doctor') ? back : '/doctor/lab-results'}?${new URLSearchParams(q)}`);
}
