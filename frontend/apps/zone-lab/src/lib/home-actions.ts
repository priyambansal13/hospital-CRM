'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Home collection actions (dispatch and the phlebotomist's steps); each returns to the page with a message. */
const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : 'Something went wrong');
const back = async (f: FormData, q: Record<string, string>) => {
  const b = String(f.get('back') ?? '/lab/visits');
  redirect(`${await origin()}${b.startsWith('/lab') ? b : '/lab/visits'}${b.includes('?') ? '&' : '?'}${new URLSearchParams(q)}`);
};
const visit = (f: FormData) => encodeURIComponent(String(f.get('visitId')));

export async function assignVisit(f: FormData) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    const v = await api<{ orderNo: string; phlebotomist: { name: string }; localTime: string }>(`/api/diagnostics/v1/lab/home-visits/${visit(f)}/assign`, { token, body: { phlebotomistId: String(f.get('phlebotomistId')) } });
    q = { ok: `${v.orderNo} (${v.localTime}) assigned to ${v.phlebotomist.name}` };
  } catch (e) {
    q = { error: msg(e) };
  }
  return back(f, q);
}

/** start / arrive / miss */
export async function visitStep(f: FormData) {
  const { accessToken: token } = await actionSession();
  const step = String(f.get('step'));
  const labels: Record<string, string> = { start: 'On your way — the patient has been told', arrive: 'Arrived', miss: 'Marked as missed — the patient will be asked to pick a new time' };
  let q: Record<string, string>;
  try {
    if (!labels[step]) throw new Error('unknown step');
    await api(`/api/diagnostics/v1/home-visits/${visit(f)}/${step}`, { token, body: step === 'miss' ? { reason: String(f.get('reason') ?? '') } : {} });
    q = { ok: labels[step] };
  } catch (e) {
    q = { error: msg(e) };
  }
  return back(f, q);
}

export async function collectAtHome(f: FormData) {
  const { accessToken: token } = await actionSession();
  const barcode = String(f.get('barcode') ?? '').trim().toUpperCase();
  let q: Record<string, string>;
  try {
    const r = await api<{ pendingSamples: number }>(`/api/diagnostics/v1/home-visits/${visit(f)}/collect`, { token, body: { barcode } });
    q = { ok: r.pendingSamples ? `${barcode} collected — ${r.pendingSamples} more tube${r.pendingSamples === 1 ? '' : 's'} to go` : `${barcode} collected — all tubes collected. Take them to the lab.` };
  } catch (e) {
    q = { error: `${barcode}: ${msg(e)}` };
  }
  return back(f, q);
}

export async function payAtHome(f: FormData) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    const r = await api<{ total: number; invoiceNo: string }>('/api/billing/v1/desk/collect', {
      token, idempotencyKey: String(f.get('idempotencyKey')),
      body: { sourceType: 'LAB_ORDER', sourceId: String(f.get('orderId')), method: String(f.get('method')), reference: String(f.get('reference') ?? '') || null },
    });
    // diagnostics hears about the payment by event: wait briefly so the page shows it as paid
    for (let i = 0; i < 15; i++) {
      const mine = await api<{ visits: { id: string; paymentStatus: string }[] }>('/api/diagnostics/v1/home-visits/mine', { token }).catch(() => null);
      if (mine?.visits.find((v) => v.id === String(f.get('visitId')))?.paymentStatus === 'PAID') break;
      await new Promise((res) => setTimeout(res, 200));
    }
    q = { ok: `₹${r.total} received (${String(f.get('method')).toLowerCase()}), receipt ${r.invoiceNo}` };
  } catch (e) {
    q = { error: msg(e) };
  }
  return back(f, q);
}
