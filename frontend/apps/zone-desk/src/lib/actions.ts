'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Front desk server actions; each redirects back inside /desk with ?ok= or ?error= (works without client JS). */
const errorText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path || 'form'}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');
const go = async (path: string, q: Record<string, string>) => {
  const safe = path.startsWith('/desk') ? path : '/desk';
  redirect(`${await origin()}${safe}${safe.includes('?') ? '&' : '?'}${new URLSearchParams(q)}`);
};
const back = (f: FormData) => String(f.get('back') ?? '/desk');

async function run(f: FormData, call: (token: string) => Promise<any>, ok: (r: any) => string) {
  const { accessToken } = await actionSession();
  let q: Record<string, string>;
  try {
    q = { ok: ok(await call(accessToken)) };
  } catch (e) {
    q = { error: errorText(e) };
  }
  return go(back(f), q);
}

const appt = (f: FormData) => encodeURIComponent(String(f.get('id')));

export async function checkIn(f: FormData) {
  return run(f, (token) => api(`/api/scheduling/v1/desk/appointments/${appt(f)}/check-in`, { token, method: 'POST' }),
    (a) => `${a.patient.name} checked in${a.tokenNo ? ` — token ${a.tokenNo}` : ''} for ${a.doctor.name}`);
}
export async function noShow(f: FormData) {
  return run(f, (token) => api(`/api/scheduling/v1/appointments/${appt(f)}/no-show`, { token, method: 'POST' }), (a) => `${a.patient.name} marked as no-show`);
}
export async function cancel(f: FormData) {
  return run(f, (token) => api(`/api/scheduling/v1/appointments/${appt(f)}/cancel`, { token, body: { reason: 'CANCELLED_AT_DESK' } }), (a) => `${a.appointmentNo} cancelled`);
}

export async function registerPatient(f: FormData) {
  const { accessToken: token } = await actionSession();
  const body = {
    phone: String(f.get('phone') ?? ''), fullName: String(f.get('fullName') ?? ''), dob: String(f.get('dob') ?? ''),
    gender: f.get('gender') ? String(f.get('gender')) : null, relation: String(f.get('relation') ?? 'SELF'),
  };
  let p: { id: string; fullName: string; mrn: string };
  try {
    p = await api('/api/patient/v1/desk/patients', { token, body });
  } catch (e) {
    const existing = e instanceof ApiError ? ((e.problem.patient ?? e.problem.holder) as { id: string } | undefined) : undefined;
    const branch = String(f.get('branch') ?? '');
    return go(`/desk/patients?q=${encodeURIComponent(body.phone)}${/^[0-9a-f-]{36}$/.test(branch) ? `&branch=${branch}` : ''}`, { error: errorText(e), ...(existing ? { highlight: existing.id } : {}) });
  }
  const branch = String(f.get('branch') ?? '');
  return go(`/desk/book?patientId=${p.id}${/^[0-9a-f-]{36}$/.test(branch) ? `&branch=${branch}` : ''}`, { ok: `Registered ${p.fullName} (${p.mrn})` });
}

export async function book(f: FormData) {
  const { accessToken: token } = await actionSession();
  const pick = String(f.get('pick') ?? '');
  const [doctorId, branchId] = [String(f.get('doctorId')), String(f.get('branchId'))];
  const reason = String(f.get('reason') ?? '').trim() || null;
  const body = { patientId: String(f.get('patientId')), reason, checkIn: f.get('checkIn') === 'on', ...(pick === 'walkin' ? { walkIn: { doctorId, branchId } } : { slotId: pick }) };
  let a: { appointmentNo: string; patient: { name: string }; doctor: { name: string }; tokenNo: number | null; status: string; localTime: string };
  try {
    if (!pick) throw new Error('pick a time or "join the queue now"');
    a = await api('/api/scheduling/v1/desk/appointments', { token, body, idempotencyKey: String(f.get('idempotencyKey')) });
  } catch (e) {
    return go(`/desk/book?patientId=${body.patientId}&branch=${branchId}&doctor=${doctorId}`, { error: e instanceof Error && !(e instanceof ApiError) ? e.message : errorText(e) });
  }
  const what = a.status === 'CHECKED_IN' ? (a.tokenNo ? `checked in — token ${a.tokenNo}` : 'checked in') : `booked for ${a.localTime}`;
  return go(`/desk?branch=${branchId}`, { ok: `${a.patient.name} ${what} with ${a.doctor.name} (${a.appointmentNo})` });
}

/** Take the fee at the counter (cash, the hospital's UPI QR, or the card machine). */
export async function collectPayment(f: FormData) {
  const method = String(f.get('method') ?? 'CASH');
  const id = String(f.get('id'));
  return run(f, async (token) => {
    // a just-booked visit's invoice is created from the booking event: give it a moment if it isn't there yet
    let inv: any;
    for (let i = 0; ; i++) {
      try {
        inv = await api('/api/billing/v1/desk/collect', {
          token, idempotencyKey: String(f.get('idempotencyKey')),
          body: { sourceId: id, method, reference: String(f.get('reference') ?? '').trim() || null },
        });
        break;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404) || i >= 15) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // the board reads payment status from scheduling, which hears about it by event: wait (briefly) so the
    // receptionist doesn't see a stale "Collect" button
    for (let i = 0; i < 15; i++) {
      const a = await api<{ paymentStatus: string }>(`/api/scheduling/v1/appointments/${encodeURIComponent(id)}`, { token }).catch(() => null);
      if (a?.paymentStatus === 'PAID') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return inv;
  }, (inv) => `₹${inv.total} received (${method.toLowerCase()}) for ${inv.patient.name} — ${inv.invoiceNo}`);
}

/** AI assistant: the patient was called back; close their chat request. */
export async function closeChatRequest(f: FormData) {
  return run(f, (token) => api(`/api/assistant/v1/assistant/handoffs/${encodeURIComponent(String(f.get('id')))}/close`, { token, body: { note: String(f.get('note') ?? '').trim() || null } }),
    (h) => `Chat request from ${h.name} closed`);
}
