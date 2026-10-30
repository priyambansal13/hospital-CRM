'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Wave 3 desk actions (move a booking, hand back a refund); each redirects back inside /desk with ?ok= or ?error=. */
const errorText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path || 'form'}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');
const go = async (path: string, q: Record<string, string>) => {
  const safe = path.startsWith('/desk') ? path : '/desk';
  redirect(`${await origin()}${safe}${safe.includes('?') ? '&' : '?'}${new URLSearchParams(q)}`);
};

/** E-1: move a booking to another time (same doctor); the payment travels with it. */
export async function moveAppointment(f: FormData) {
  const { accessToken: token } = await actionSession();
  const id = encodeURIComponent(String(f.get('id')));
  const back = String(f.get('back') ?? '/desk');
  const slot = String(f.get('slotId') ?? '');
  let a: { appointmentNo: string; patient: { name: string }; localDate: string; localTime: string };
  try {
    if (!slot) throw new Error('pick a time');
    a = await api(`/api/scheduling/v1/appointments/${id}/reschedule`, { token, body: { newSlotId: slot } });
  } catch (e) {
    return go(`/desk/move/${id}?back=${encodeURIComponent(back)}`, { error: e instanceof Error && !(e instanceof ApiError) ? e.message : errorText(e) });
  }
  return go(back, { ok: `${a.patient.name} moved to ${a.localDate} ${a.localTime} (${a.appointmentNo})` });
}

/** The refund was given back at the counter. */
export async function handedBack(f: FormData) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    const r = await api<{ amount: number }>(`/api/billing/v1/refunds/${encodeURIComponent(String(f.get('id')))}/handed-back`, { token, body: { method: f.get('method') ?? 'CASH' } });
    q = { ok: `₹${r.amount} handed back: the patient is told and the invoice updated` };
  } catch (e) {
    q = { error: errorText(e) };
  }
  return go('/desk/collections', q);
}
