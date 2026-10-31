'use server';
import { actionSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import { errorText } from '@/lib/directory';

const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/memberships?${new URLSearchParams(q)}`);
const num = (f: FormData, k: string) => Number(f.get(k) ?? 0);

/** The tier form's fields → the API's shape (one form for new and existing tiers). */
const tier = (f: FormData) => ({
  name: String(f.get('name') ?? ''), description: String(f.get('description') ?? '') || null,
  price: num(f, 'price'), period: String(f.get('period') ?? 'MONTHLY'), sort: num(f, 'sort'),
  benefits: {
    bookingWindowDays: num(f, 'bookingWindowDays'), priorityAccess: f.get('priorityAccess') === 'on', freeVideoConsultsPerMonth: num(f, 'freeVideoConsultsPerMonth'),
    labDiscountPct: num(f, 'labDiscountPct'), freeHomeCollection: f.get('freeHomeCollection') === 'on', familyMembers: num(f, 'familyMembers'),
  },
});

export async function saveTier(form: FormData) {
  const { accessToken: token } = await actionSession();
  const id = String(form.get('id') ?? '');
  try {
    if (id) await api(`/api/billing/v1/membership-plans/${id}`, { token, method: 'PATCH', body: { ...tier(form), version: num(form, 'version') } });
    else await api('/api/billing/v1/membership-plans', { token, body: { ...tier(form), code: form.get('code') } });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: `Saved ${form.get('name')}` });
}

export async function toggleTier(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/billing/v1/membership-plans/${form.get('id')}`, { token, method: 'PATCH', body: { active: form.get('active') === 'true', version: num(form, 'version') } });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: 'Updated' });
}
