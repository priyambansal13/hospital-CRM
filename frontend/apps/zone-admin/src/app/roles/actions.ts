'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const back = async (role: string, q: Record<string, string>) => redirect(`${await origin()}/admin/roles?${new URLSearchParams({ ...(role ? { role } : {}), ...q })}`);
const message = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');

async function run(role: string, fn: (token: string) => Promise<unknown>, ok: string) {
  const { accessToken: token } = await actionSession();
  try {
    await fn(token);
  } catch (e) {
    return back(role, { error: message(e) });
  }
  return back(role, { ok });
}

export async function createRole(f: FormData) {
  const code = str(f, 'code').toUpperCase().replace(/[^A-Z_]/g, '_');
  return run(code, (token) => api('/api/entitlement/v1/roles', { token, body: { code, name: str(f, 'name'), description: str(f, 'description') || null, copyFrom: str(f, 'copyFrom') || null } }), `Role ${str(f, 'name')} created`);
}

export async function saveRole(f: FormData) {
  const role = str(f, 'role');
  return run(role, (token) => api(`/api/entitlement/v1/roles/${role}`, { token, method: 'PUT', body: { permissions: f.getAll('permission').map(String) } }), 'Permissions saved: they apply at once');
}

export async function deleteRole(f: FormData) {
  return run('', (token) => api(`/api/entitlement/v1/roles/${str(f, 'role')}`, { token, method: 'DELETE' }), `Role ${str(f, 'role')} deleted`);
}

export async function giveRole(f: FormData) {
  const role = str(f, 'role');
  return run(role, (token) => api(`/api/entitlement/v1/users/${str(f, 'userId')}/roles`, { token, body: { roleCode: role } }), 'Role given');
}

export async function takeRole(f: FormData) {
  const role = str(f, 'role');
  return run(role, (token) => api(`/api/entitlement/v1/users/${str(f, 'userId')}/roles/${role}`, { token, method: 'DELETE' }), 'Role removed');
}
