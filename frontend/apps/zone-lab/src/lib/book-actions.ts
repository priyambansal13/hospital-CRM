'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Staff booking of lab tests (D-3) and dispatcher actions (D-10); each redirects back with ?ok= or ?error=. */
const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path ? `${x.path}: ` : ''}${x.message}`).join('; ') || e.message) : e instanceof Error ? e.message : 'Something went wrong');
const go = async (path: string, q: Record<string, string>) => redirect(`${await origin()}${path.startsWith('/lab') ? path : '/lab'}${path.includes('?') ? '&' : '?'}${new URLSearchParams(q)}`);

export async function bookTests(f: FormData) {
  const { accessToken: token } = await actionSession();
  const back = String(f.get('back') ?? '/lab/book');
  const items = f.getAll('testId').map((id) => ({ testId: String(id) }));
  let o: { orderNo: string; patient: { name: string }; total: number; localTime: string | null };
  try {
    if (!items.length) throw new Error('tick at least one test');
    if (!f.get('slotAt')) throw new Error('pick a time');
    o = await api('/api/diagnostics/v1/desk/lab-orders', {
      token, idempotencyKey: String(f.get('idempotencyKey')),
      body: { patientId: f.get('patientId'), branchId: f.get('branchId'), slotAt: f.get('slotAt'), items },
    });
  } catch (e) {
    return go(back, { error: msg(e) });
  }
  return go(String(f.get('done') ?? '/lab'), { ok: `${o.orderNo} booked for ${o.patient.name}${o.localTime ? ` at ${o.localTime}` : ''}: ₹${o.total} to collect` });
}

export async function scheduleOrder(f: FormData) {
  const { accessToken: token } = await actionSession();
  const back = String(f.get('back') ?? '/lab/book');
  let o: { orderNo: string; patient: { name: string }; localTime: string | null };
  try {
    if (!f.get('slotAt')) throw new Error('pick a time');
    o = await api(`/api/diagnostics/v1/desk/lab-orders/${encodeURIComponent(String(f.get('orderId')))}/schedule`, { token, body: { branchId: f.get('branchId'), slotAt: f.get('slotAt') } });
  } catch (e) {
    return go(back, { error: msg(e) });
  }
  return go(String(f.get('done') ?? '/lab'), { ok: `${o.orderNo} for ${o.patient.name} booked${o.localTime ? ` at ${o.localTime}` : ''}` });
}

/** D-10: the visit cannot happen; the patient is asked to pick a new time. */
export async function visitMissed(f: FormData) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    await api(`/api/diagnostics/v1/lab/home-visits/${encodeURIComponent(String(f.get('id')))}/missed`, { token, body: { reason: String(f.get('reason') ?? '').trim() } });
    q = { ok: 'Visit closed: the patient has been asked to pick a new time' };
  } catch (e) {
    q = { error: msg(e) };
  }
  return go(String(f.get('back') ?? '/lab/home'), q);
}
