'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path || 'form'}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');
const go = async (path: string, q: Record<string, string>) => {
  const qs = new URLSearchParams(q).toString();
  redirect(`${await origin()}${path.startsWith('/care/') ? path : '/care/lab-orders'}${qs ? `${path.includes('?') ? '&' : '?'}${qs}` : ''}`);
};
const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim() || null;

/** Book chosen tests (or a doctor's order, or a new visit after a missed one) for collection at home. */
export async function bookHomeVisit(f: FormData) {
  const { accessToken: token } = await actionSession();
  const orderId = String(f.get('orderId') ?? '');
  const slotAt = String(f.get('slotAt') ?? '');
  const backTo = String(f.get('back') ?? '/care/tests');
  const paymentMode = f.get('paymentMode') === 'ONLINE' ? 'ONLINE' : 'AT_CLINIC';
  const home = { line1: field(f, 'line1') ?? '', line2: field(f, 'line2'), landmark: field(f, 'landmark'), city: field(f, 'city'), pincode: String(f.get('pincode') ?? ''), phone: (field(f, 'phone') ?? '').replace(/[\s-]/g, '') };
  let r: { orderNo: string; status: string; localTime: string; payment?: { invoiceId: string } };
  try {
    if (!slotAt) throw new ApiError(400, { status: 400, code: 'NO_TIME', detail: 'Pick a time' });
    r = orderId
      ? await api(`/api/diagnostics/v1/lab-orders/${encodeURIComponent(orderId)}/schedule`, { token, body: { home, slotAt, paymentMode } })
      : await api('/api/diagnostics/v1/lab-orders', {
        token, idempotencyKey: String(f.get('idempotencyKey')),
        body: { patientId: String(f.get('patientId')), home, slotAt, paymentMode, items: [...f.getAll('pkg').map((p) => ({ packageId: String(p) })), ...f.getAll('test').map((t) => ({ testId: String(t) }))] },
      });
  } catch (e) {
    return go(backTo, { error: msg(e) });
  }
  if (r.payment) return go(`/care/pay/${r.payment.invoiceId}`, {});
  return go('/care/lab-orders', { ok: `Booked ${r.orderNo}: sample collection at home. ${r.status === 'BOOKED' && paymentMode === 'AT_CLINIC' ? 'Pay the collector when they come.' : ''}`.trim() });
}
