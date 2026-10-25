'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/** Health record actions: uploads (two steps around the browser's direct PUT), allergies, sharing. */
const msg = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path || 'form'}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');
const go = async (path: string, q: Record<string, string>) => {
  const qs = new URLSearchParams(q).toString();
  redirect(`${await origin()}${path.startsWith('/care/') ? path : '/care/timeline'}${qs ? `${path.includes('?') ? '&' : '?'}${qs}` : ''}`);
};

export interface UploadTicket { uploadId: string; url: string; headers: Record<string, string>; error?: undefined }

/** Step 1: a 5-minute URL to PUT the file straight into the hospital's storage. */
export async function requestUpload(patientId: string, file: { name: string; type: string; size: number }): Promise<UploadTicket | { error: string }> {
  const { accessToken: token } = await actionSession();
  try {
    return await api<UploadTicket>(`/api/records/v1/patients/${encodeURIComponent(patientId)}/documents/upload-url`, { token, body: { fileName: file.name, mimeType: file.type, sizeBytes: file.size } });
  } catch (e) {
    return { error: msg(e) };
  }
}

/** Step 2: the file is there; record it (it becomes visible once the virus scan passes). */
export async function registerUpload(patientId: string, v: { uploadId: string; title: string; type: string; issuedOn: string | null }): Promise<{ ok: true } | { error: string }> {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/records/v1/patients/${encodeURIComponent(patientId)}/documents`, { token, body: v });
    return { ok: true };
  } catch (e) {
    return { error: msg(e) };
  }
}

export async function addAllergy(f: FormData) {
  const { accessToken: token } = await actionSession();
  const p = String(f.get('patientId'));
  try {
    await api(`/api/patient/v1/me/patients/${encodeURIComponent(p)}/allergies`, { token, body: { substance: String(f.get('substance') ?? ''), severity: String(f.get('severity') ?? 'UNKNOWN'), reaction: String(f.get('reaction') ?? '').trim() || null } });
  } catch (e) {
    return go(`/care/timeline?patientId=${p}`, { error: msg(e) });
  }
  return go(`/care/timeline?patientId=${p}`, { ok: `${f.get('substance')} allergy recorded` });
}

export async function removeAllergy(f: FormData) {
  const { accessToken: token } = await actionSession();
  const p = String(f.get('patientId'));
  try {
    await api(`/api/patient/v1/me/patients/${encodeURIComponent(p)}/allergies/${encodeURIComponent(String(f.get('allergyId')))}`, { token, method: 'DELETE' });
  } catch (e) {
    return go(`/care/timeline?patientId=${p}`, { error: msg(e) });
  }
  return go(`/care/timeline?patientId=${p}`, { ok: 'Allergy removed' });
}

export async function removeDocument(f: FormData) {
  const { accessToken: token } = await actionSession();
  const p = String(f.get('patientId'));
  try {
    await api(`/api/records/v1/documents/${encodeURIComponent(String(f.get('documentId')))}`, { token, method: 'DELETE' });
  } catch (e) {
    return go(`/care/timeline?patientId=${p}`, { error: msg(e) });
  }
  return go(`/care/timeline?patientId=${p}`, { ok: 'Document removed' });
}

export async function shareRecord(f: FormData) {
  const { accessToken: token } = await actionSession();
  const p = String(f.get('patientId'));
  let doctor = '';
  try {
    const c = await api<{ doctor: { name: string } }>('/api/patient/v1/me/consents', { token, body: { patientId: p, doctorId: String(f.get('doctorId')), scope: f.getAll('scope').map(String), days: Number(f.get('days')) } });
    doctor = c.doctor.name;
  } catch (e) {
    return go(`/care/sharing?patientId=${p}`, { error: msg(e) });
  }
  return go(`/care/sharing?patientId=${p}`, { ok: `Shared with ${doctor}` });
}

export async function revokeShare(f: FormData) {
  const { accessToken: token } = await actionSession();
  const p = String(f.get('patientId'));
  try {
    await api(`/api/patient/v1/me/consents/${encodeURIComponent(String(f.get('consentId')))}`, { token, method: 'DELETE' });
  } catch (e) {
    return go(`/care/sharing?patientId=${p}`, { error: msg(e) });
  }
  return go(`/care/sharing?patientId=${p}`, { ok: 'Access removed' });
}

/** Book lab tests (or a time for tests the doctor ordered). Online → the payment page; otherwise My lab tests. */
export async function bookLab(f: FormData) {
  const { accessToken: token } = await actionSession();
  const orderId = String(f.get('orderId') ?? '');
  const slotAt = String(f.get('slotAt') ?? '');
  const backTo = String(f.get('back') ?? '/care/tests');
  const paymentMode = f.get('paymentMode') === 'ONLINE' ? 'ONLINE' : 'AT_CLINIC';
  let r: { orderNo: string; status: string; payment?: { invoiceId: string } };
  try {
    if (!slotAt) throw new ApiError(400, { status: 400, code: 'NO_TIME', detail: 'Pick a time' });
    r = orderId
      ? await api(`/api/diagnostics/v1/lab-orders/${encodeURIComponent(orderId)}/schedule`, { token, body: { branchId: String(f.get('branchId')), slotAt, paymentMode } })
      : await api('/api/diagnostics/v1/lab-orders', {
        token, idempotencyKey: String(f.get('idempotencyKey')),
        body: { patientId: String(f.get('patientId')), branchId: String(f.get('branchId')), slotAt, paymentMode, items: [...f.getAll('pkg').map((p) => ({ packageId: String(p) })), ...f.getAll('test').map((t) => ({ testId: String(t) }))] },
      });
  } catch (e) {
    return go(backTo, { error: msg(e) });
  }
  if (r.payment) return go(`/care/pay/${r.payment.invoiceId}`, {});
  return go('/care/lab-orders', { ok: `Booked ${r.orderNo}. Pay at the lab.` });
}

export async function cancelLab(f: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/diagnostics/v1/lab-orders/${encodeURIComponent(String(f.get('orderId')))}/cancel`, { token, body: { reason: null } });
  } catch (e) {
    return go('/care/lab-orders', { error: msg(e) });
  }
  return go('/care/lab-orders', { ok: 'Lab booking cancelled. Anything you paid will be refunded.' });
}
