'use server';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/** Sign up: nothing is created until the owner opens the link we e-mail. */
export async function signup(f: FormData) {
  const fields = { hospitalName: str(f, 'hospitalName'), slug: str(f, 'slug').toLowerCase(), adminName: str(f, 'adminName'), adminEmail: str(f, 'adminEmail'), phone: str(f, 'phone') || null, plan: str(f, 'plan') };
  try {
    await api('/api/tenant/v1/signup', { body: fields });
  } catch (e) {
    const msg = e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || e.message) : 'Something went wrong';
    const keep = new URLSearchParams({ error: msg, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v).map(([k, v]) => [k, String(v)])) });
    return redirect(`${await origin()}/signup?${keep}`);
  }
  return redirect(`${await origin()}/signup/sent?email=${encodeURIComponent(fields.adminEmail)}`);
}
