'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/setup?${new URLSearchParams(q)}`);
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

export async function addBranch(f: FormData) {
  return run((token) => api('/api/tenant/v1/branches', { token, idempotencyKey: str(f, 'idempotencyKey'), body: { name: str(f, 'name'), city: str(f, 'city'), address: { line1: str(f, 'line1') } } }), `Branch ${str(f, 'name')} added`);
}

/** A first doctor, published at once so patients can find them. */
export async function addDoctor(f: FormData) {
  return run(async (token) => {
    const body = { name: str(f, 'name'), email: str(f, 'email'), registrationNo: str(f, 'registrationNo'), specialties: [{ code: str(f, 'specialty'), primary: true }], branches: [{ branchId: str(f, 'branchId'), fee: Number(str(f, 'fee') || 0) }], consultModes: ['IN_PERSON'] };
    // a branch added a moment ago reaches the doctor directory by event
    let attempt = 0;
    const d = await settled(() => api<{ id: string }>('/api/provider/v1/doctors', { token, idempotencyKey: `${str(f, 'idempotencyKey')}-${attempt++}`, body }), 'UNKNOWN_BRANCH');
    await api(`/api/provider/v1/doctors/${d.id}/status`, { token, body: { status: 'ACTIVE' } });
  }, `${str(f, 'name')} added and published`);
}

/** Retry while another service has not yet heard (by event) about something just created in the guide. */
async function settled<T>(fn: () => Promise<T>, code: string, tries = 10): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === code) || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export async function addHours(f: FormData) {
  // a doctor added a moment ago reaches scheduling by event
  return run((token) => settled(() => api(`/api/scheduling/v1/doctors/${str(f, 'doctorId')}/availability`, {
    token, body: { days: f.getAll('day').map(Number), branchId: str(f, 'branchId'), startTime: str(f, 'startTime'), endTime: str(f, 'endTime'), slotMinutes: Number(str(f, 'slotMinutes')) },
  }), 'NOT_FOUND'), 'Opening hours saved: patients can book now');
}

export async function connectPayments(f: FormData) {
  return run((token) => api('/api/billing/v1/payment-account', { token, method: 'PUT', body: { businessName: str(f, 'businessName'), businessType: str(f, 'businessType'), pan: str(f, 'pan'), accountNumber: str(f, 'accountNumber'), ifsc: str(f, 'ifsc'), email: str(f, 'email') } }), 'Bank account connected: patients can pay online');
}

export async function finishSetup() {
  return run((token) => api('/api/tenant/v1/setup/complete', { token, body: {} }), 'All set');
}
