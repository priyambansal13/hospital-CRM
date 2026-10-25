'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

export async function refundInvoice(form: FormData) {
  const { accessToken: token } = await actionSession();
  const id = String(form.get('invoiceId'));
  const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/billing/${encodeURIComponent(id)}?${new URLSearchParams(q)}`);
  const amount = Number(form.get('amount'));
  try {
    await api(`/api/billing/v1/invoices/${encodeURIComponent(id)}/refunds`, { token, idempotencyKey: String(form.get('idempotencyKey')), body: { amount, reason: String(form.get('reason') ?? '') } });
  } catch (e) {
    return back({ error: e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || e.message) : 'Could not refund' });
  }
  return back({ ok: `Refund of ₹${amount} started` });
}
