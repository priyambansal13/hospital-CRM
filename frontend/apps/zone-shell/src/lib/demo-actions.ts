'use server';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import { attribution } from './attribution';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/** "Book a demo": a lead for MediCare's sales team, with where the visitor came from. */
export async function requestDemo(f: FormData) {
  const doctors = str(f, 'doctors');
  const fields = { name: str(f, 'name'), email: str(f, 'email'), phone: str(f, 'phone') || null, hospitalName: str(f, 'hospitalName'), city: str(f, 'city') || null, segment: str(f, 'segment'), doctors: doctors ? Number(doctors) : null, message: str(f, 'message') || null };
  try {
    await api('/api/tenant/v1/leads', { body: { ...fields, attribution: await attribution() } });
  } catch (e) {
    const msg = e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || e.message) : 'Something went wrong';
    const keep = new URLSearchParams({ error: msg, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])) });
    return redirect(`${await origin()}/demo?${keep}`);
  }
  return redirect(`${await origin()}/demo/thanks`);
}
