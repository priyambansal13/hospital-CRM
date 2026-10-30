import { freshSession } from '@mc/auth/fresh';
import { api } from '@mc/bff';

export const dynamic = 'force-dynamic';

/**
 * "Download my data" (review H-1, India's DPDP Act: the right to a copy): everything the hospital holds for the account
 * holder and their family, as one JSON file, read through the same APIs the patient's pages use (so every record read
 * is audited as the patient's own).
 */
export async function GET() {
  const s = await freshSession();
  if (!s) return new Response('sign in required', { status: 401 });
  const token = s.accessToken;
  const get = <T,>(path: string) => api<T>(path, { token }).catch((e: Error) => ({ unavailable: e.message }) as unknown as T);
  const family = await api<{ id: string; fullName: string }[]>('/api/patient/v1/me/patients', { token });
  const people = await Promise.all(family.map(async (p) => {
    const timeline: unknown[] = [];
    let path = `/api/records/v1/patients/${p.id}/timeline`;
    for (let i = 0; i < 20; i++) {
      const page = await get<{ items?: unknown[]; next?: { at: string; id: string } | null }>(path);
      timeline.push(...(page.items ?? []));
      if (!page.next) break;
      path = `/api/records/v1/patients/${p.id}/timeline?${new URLSearchParams({ beforeAt: page.next.at, beforeId: page.next.id })}`;
    }
    return {
      patient: p,
      allergies: await get(`/api/patient/v1/me/patients/${p.id}/allergies`),
      consents: await get(`/api/patient/v1/me/consents?patientId=${p.id}`),
      documents: await get(`/api/records/v1/patients/${p.id}/documents`),
      timeline,
      accessLog: await get(`/api/audit/v1/me/access-log?patientId=${p.id}`),
    };
  }));
  const body = {
    exportedAt: new Date().toISOString(),
    note: 'A copy of your records at this hospital. Documents are listed here; download each one from Health record.',
    profile: await get('/api/patient/v1/me/profile'),
    people,
    appointments: await get('/api/scheduling/v1/me/appointments'),
    waitlist: await get('/api/scheduling/v1/me/waitlist'),
    prescriptions: await get('/api/records/v1/me/prescriptions'),
    labOrders: await get('/api/diagnostics/v1/me/lab-orders'),
    bills: await get('/api/billing/v1/me/invoices'),
    messagePreferences: await get('/api/notification/v1/me/notification-preferences'),
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="my-health-data-${new Date().toISOString().slice(0, 10)}.json"`, 'cache-control': 'private, no-store' },
  });
}
