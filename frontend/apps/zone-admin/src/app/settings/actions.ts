'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/settings?${new URLSearchParams(q)}`);
const message = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');

async function run(fn: (token: string) => Promise<unknown>, ok: string) {
  const { accessToken: token } = await actionSession();
  try {
    await fn(token);
  } catch (e) {
    return back({ error: message(e) });
  }
  return back({ ok });
}

export async function saveBranding(f: FormData) {
  return run((token) => api('/api/tenant/v1/branding', { token, method: 'PATCH', body: { name: str(f, 'name'), primaryColor: str(f, 'primaryColor'), accentColor: str(f, 'accentColor'), logoUrl: str(f, 'logoUrl') || null } }), 'Branding saved');
}

export async function saveSetting(f: FormData) {
  const type = str(f, 'type');
  const raw = str(f, 'value');
  const value = type === 'int' ? Number(raw) : type === 'bool' ? raw === 'true' : raw;
  return run((token) => api(`/api/entitlement/v1/settings/${encodeURIComponent(str(f, 'key'))}`, { token, method: 'PUT', body: { value } }), 'Setting saved');
}

export async function addDomain(f: FormData) {
  return run((token) => api('/api/tenant/v1/domains', { token, body: { host: str(f, 'host') } }), `${str(f, 'host')} added: create the DNS record below, then verify`);
}

export async function verifyDomain(f: FormData) {
  return run((token) => api(`/api/tenant/v1/domains/${encodeURIComponent(str(f, 'host'))}/verify`, { token, body: {} }), `${str(f, 'host')} verified: it now opens your hospital`);
}

export async function removeDomain(f: FormData) {
  return run((token) => api(`/api/tenant/v1/domains/${encodeURIComponent(str(f, 'host'))}`, { token, method: 'DELETE' }), `${str(f, 'host')} removed`);
}

