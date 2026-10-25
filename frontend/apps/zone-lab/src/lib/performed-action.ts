'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** X-ray, ECG and other tests without a sample: the patient was seen, so the order moves on to the report. */
export async function markPerformed(f: FormData) {
  const { accessToken: token } = await actionSession();
  const b = String(f.get('back') ?? '/lab');
  let q: Record<string, string>;
  try {
    const o = await api<{ orderNo: string; patient: { name: string } }>(`/api/diagnostics/v1/lab/lab-orders/${encodeURIComponent(String(f.get('orderId')))}/performed`, { token, method: 'POST', idempotencyKey: crypto.randomUUID() });
    q = { ok: `${o.orderNo}: ${o.patient.name} seen; the report can be written now` };
  } catch (e) {
    q = { error: e instanceof ApiError ? e.message : 'Something went wrong' };
  }
  redirect(`${await origin()}${b.startsWith('/lab') ? b : '/lab'}${b.includes('?') ? '&' : '?'}${new URLSearchParams(q)}`);
}
