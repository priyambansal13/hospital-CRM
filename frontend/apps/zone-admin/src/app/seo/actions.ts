'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const message = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');

async function run(fn: (token: string) => Promise<unknown>, ok: string, anchor: string) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    await fn(token);
    q = { ok };
  } catch (e) {
    q = { error: message(e) };
  }
  return redirect(`${await origin()}/admin/seo?${new URLSearchParams(q)}#${anchor}`);
}

/** The sentence or two about the hospital on its home page and in search results. */
export async function saveDescription(f: FormData) {
  return run((token) => api('/api/tenant/v1/branding', { token, method: 'PATCH', body: { description: str(f, 'description') || null } }), 'Description saved', 'about');
}

/** The area a branch serves ("Sector 62, Noida"), used in its page title. */
export async function saveArea(f: FormData) {
  return run((token) => api(`/api/tenant/v1/branches/${encodeURIComponent(str(f, 'id'))}`, { token, method: 'PATCH', body: { area: str(f, 'area') || null, version: Number(f.get('version')) } }), 'Branch area saved', 'branches');
}
