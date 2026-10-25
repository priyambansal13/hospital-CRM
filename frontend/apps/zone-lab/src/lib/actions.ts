'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Lab bench actions; each returns to the worklist with a message (works without client JS, and with a scanner). */
const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : 'Something went wrong');
const back = async (f: FormData, q: Record<string, string>) => {
  const b = String(f.get('back') ?? '/lab');
  redirect(`${await origin()}${b.startsWith('/lab') ? b : '/lab'}${b.includes('?') ? '&' : '?'}${new URLSearchParams(q)}`);
};

export async function scan(f: FormData) {
  const { accessToken: token } = await actionSession();
  const barcode = String(f.get('barcode') ?? '').trim().toUpperCase();
  const step = f.get('step') === 'receive' ? 'receive' : 'collect';
  let q: Record<string, string>;
  try {
    const r = await api<any>(`/api/diagnostics/v1/lab/samples/${step}`, { token, body: { barcode } });
    const o = r.order ?? r;
    q = { ok: step === 'collect'
      ? `${barcode} collected for ${o.patient.name}${r.pendingSamples ? ` — ${r.pendingSamples} more tube${r.pendingSamples === 1 ? '' : 's'} to go` : ' — all tubes collected'}`
      : `${barcode} received at the lab${o.status === 'IN_LAB' ? ` — ${o.orderNo} is in the lab` : ''}`, step };
  } catch (e) {
    q = { error: `${barcode}: ${msg(e)}`, step };
  }
  return back(f, q);
}

export async function reject(f: FormData) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    const r = await api<{ replacement: string; rejected: string }>('/api/diagnostics/v1/lab/samples/reject', { token, body: { barcode: String(f.get('barcode')), reason: String(f.get('reason') ?? '') } });
    q = { ok: `${r.rejected} rejected. New label ${r.replacement}; the patient has been asked to come back.` };
  } catch (e) {
    q = { error: msg(e) };
  }
  return back(f, q);
}

export async function collectPayment(f: FormData) {
  const { accessToken: token } = await actionSession();
  const method = String(f.get('method') ?? 'CASH');
  let q: Record<string, string>;
  try {
    const inv = await api<{ total: number; invoiceNo: string }>('/api/billing/v1/desk/collect', {
      token, idempotencyKey: String(f.get('idempotencyKey')), body: { sourceType: 'LAB_ORDER', sourceId: String(f.get('orderId')), method, reference: String(f.get('reference') ?? '').trim() || null },
    });
    // the worklist reads payment status from diagnostics, which hears about it by event: wait briefly
    for (let i = 0; i < 15; i++) {
      const o = await api<{ paymentStatus: string }>(`/api/diagnostics/v1/lab-orders/${encodeURIComponent(String(f.get('orderId')))}`, { token }).catch(() => null);
      if (o?.paymentStatus === 'PAID') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    q = { ok: `₹${inv.total} received (${method.toLowerCase()}) — ${inv.invoiceNo}` };
  } catch (e) {
    q = { error: msg(e) };
  }
  return back(f, q);
}

