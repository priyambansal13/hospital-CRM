'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Results, verification, amendments and critical-value acknowledgement; each returns to the page with a message. */
const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : 'Something went wrong');
const back = async (f: FormData, q: Record<string, string>) => {
  const b = String(f.get('back') ?? '/lab');
  redirect(`${await origin()}${b.startsWith('/lab') ? b : '/lab'}${b.includes('?') ? '&' : '?'}${new URLSearchParams(q)}`);
};

/** Result entry: every "v:<itemId>:<parameter>" field that has a value. */
const entries = (f: FormData) => [...f.entries()].filter(([k, v]) => k.startsWith('v:') && String(v).trim()).map(([k, v]) => {
  const [, itemId, ...p] = k.split(':');
  return { itemId, parameter: p.join(':'), value: String(v).trim() };
});

export async function saveResults(f: FormData) {
  const { accessToken: token } = await actionSession();
  const id = String(f.get('orderId'));
  let q: Record<string, string>;
  try {
    const r = await api<{ order: { status: string } }>(`/api/diagnostics/v1/lab/orders/${encodeURIComponent(id)}/results`, { token, body: { results: entries(f) } });
    q = { ok: r.order.status === 'RESULTS_ENTERED' ? 'All results entered — ready for the pathologist to verify' : 'Results saved' };
  } catch (e) {
    q = { error: msg(e) };
  }
  return back(f, q);
}

export async function verifyReport(f: FormData) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    const r = await api<{ version: number; abnormal: number; critical: number }>(`/api/diagnostics/v1/lab/orders/${encodeURIComponent(String(f.get('orderId')))}/verify`, { token, method: 'POST' });
    q = { ok: `Report verified and published (version ${r.version}; ${r.abnormal} abnormal, ${r.critical} critical). The patient and doctor have been told.` };
  } catch (e) {
    q = { error: msg(e) };
  }
  return back(f, q);
}

export async function amendReport(f: FormData) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    const r = await api<{ version: number }>(`/api/diagnostics/v1/lab/orders/${encodeURIComponent(String(f.get('orderId')))}/amend`, { token, body: { reason: String(f.get('reason') ?? ''), results: entries(f) } });
    q = { ok: `Amended: version ${r.version} published, the previous version is superseded` };
  } catch (e) {
    q = { error: msg(e) };
  }
  return back(f, q);
}

export async function acknowledgeAlert(f: FormData) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    await api(`/api/diagnostics/v1/lab/critical-alerts/${encodeURIComponent(String(f.get('alertId')))}/ack`, { token, method: 'POST' });
    q = { ok: 'Critical value acknowledged' };
  } catch (e) {
    q = { error: msg(e) };
  }
  return back(f, q);
}
