'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { hoursBody, leaveBody } from '@mc/schedule-ui';
import { redirect } from 'next/navigation';

/** Server actions for the shared schedule editor; `back` must stay inside this zone (/admin). */
const backTo = async (f: FormData, q: Record<string, string>) => {
  const back = String(f.get('back') ?? '');
  const path = back.startsWith('/admin/') || back === '/admin' ? back : '/admin';
  redirect(`${await origin()}${path}?${new URLSearchParams(q)}`);
};
const errorText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path || 'form'}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');
const base = (f: FormData) => `/api/scheduling/v1/doctors/${encodeURIComponent(String(f.get('doctorId')))}`;

async function run(f: FormData, call: (token: string) => Promise<unknown>, ok: (r: any) => string) {
  const { accessToken } = await actionSession();
  let message: string;
  try {
    message = ok(await call(accessToken));
  } catch (e) {
    return backTo(f, { error: errorText(e) });
  }
  return backTo(f, { ok: message });
}

export async function addHours(f: FormData) {
  return run(f, (token) => api(`${base(f)}/availability`, { token, body: hoursBody(f) }), (r) => `Hours added: ${r.slotsGenerated} slots opened`);
}
export async function removeHours(f: FormData) {
  return run(f, (token) => api(`${base(f)}/availability/${f.get('templateId')}`, { token, method: 'DELETE' }), (r) => `Hours removed (${r.slotsRemoved} open slots closed)`);
}
export async function addLeave(f: FormData) {
  return run(f, (token) => api(`${base(f)}/leaves`, { token, body: leaveBody(f) }), (r) => `Leave added: ${r.slotsBlocked} slots blocked${r.appointmentsCancelled ? `, ${r.appointmentsCancelled} booked appointments cancelled` : ''}`);
}
export async function removeLeave(f: FormData) {
  return run(f, (token) => api(`${base(f)}/leaves/${f.get('leaveId')}`, { token, method: 'DELETE' }), (r) => `Leave cancelled: ${r.slotsReopened} slots reopened`);
}
