'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** E-10: reference ranges, critical limits, turnaround and package contents. */
const go = async (path: string, q: Record<string, string>) => redirect(`${await origin()}${path}?${new URLSearchParams(q)}`);
const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path ? `${x.path}: ` : ''}${x.message}`).join('; ') || e.message) : 'Could not save');
const num = (v: FormDataEntryValue | null) => { const s = String(v ?? '').trim().replace(',', '.'); return s === '' ? undefined : Number(s); };

export async function saveTestDetails(f: FormData) {
  const { accessToken: token } = await actionSession();
  const id = String(f.get('id'));
  const rows = Number(f.get('rows'));
  const referenceRanges = [];
  for (let i = 0; i < rows; i++) {
    const param = String(f.get(`param${i}`) ?? '').trim();
    if (!param) continue;
    const sex = String(f.get(`sex${i}`) ?? '');
    const r = { param, unit: String(f.get(`unit${i}`) ?? '').trim(), ...(sex ? { sex } : {}), low: num(f.get(`low${i}`)), high: num(f.get(`high${i}`)), criticalLow: num(f.get(`criticalLow${i}`)), criticalHigh: num(f.get(`criticalHigh${i}`)) };
    referenceRanges.push(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
  }
  try {
    await api(`/api/diagnostics/v1/admin/lab-tests/${encodeURIComponent(id)}`, { token, method: 'PATCH', body: {
      turnaroundHours: num(f.get('turnaroundHours')), fastingHours: num(f.get('fastingHours')) ?? null, referenceRanges,
    } });
  } catch (e) {
    return go(`/admin/lab-catalog/test/${id}`, { error: msg(e) });
  }
  return go(`/admin/lab-catalog/test/${id}`, { ok: 'Saved: new results use these ranges (reports already issued keep theirs)' });
}

export async function savePackageTests(f: FormData) {
  const { accessToken: token } = await actionSession();
  const id = String(f.get('id'));
  try {
    await api(`/api/diagnostics/v1/admin/lab-packages/${encodeURIComponent(id)}`, { token, method: 'PATCH', body: { testCodes: f.getAll('code').map(String) } });
  } catch (e) {
    return go(`/admin/lab-catalog/package/${id}`, { error: msg(e) });
  }
  return go(`/admin/lab-catalog/package/${id}`, { ok: 'Saved: new bookings get these tests' });
}
