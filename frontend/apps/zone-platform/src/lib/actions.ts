'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const P = '/api/subscription/v1/platform';
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const go = async (path: string, q: Record<string, string> = {}) => redirect(`${await origin()}/platform${path}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ''}`);
const message = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const { accessToken: token } = await actionSession();
  return api<T>(`${P}${path}`, { token, method, body: body ?? (method === 'GET' ? undefined : {}) });
}

// ---------- editions and plans ----------

export async function saveEdition(f: FormData) {
  try {
    await call('/editions', 'POST', { code: str(f, 'code').toUpperCase(), name: str(f, 'name'), description: str(f, 'description') || null });
  } catch (e) {
    return go('/editions', { error: message(e) });
  }
  return go('/editions', { ok: `Edition ${str(f, 'name')} saved` });
}

export async function createPlan(f: FormData) {
  let r: { versionId: string };
  try {
    r = await call('/plans', 'POST', { code: str(f, 'code').toUpperCase(), name: str(f, 'name'), edition: str(f, 'edition'), tier: str(f, 'tier'), description: str(f, 'description') || null, copyFrom: str(f, 'copyFrom') || null });
  } catch (e) {
    return go('/plans', { error: message(e) });
  }
  return go(`/plans/versions/${r.versionId}`, { ok: 'Draft created: choose modules, limits and price, then submit it for approval' });
}

export async function newVersion(f: FormData) {
  let r: { versionId: string; version: number };
  try {
    r = await call(`/plans/${encodeURIComponent(str(f, 'plan'))}/versions`, 'POST');
  } catch (e) {
    const id = e instanceof ApiError ? (e.problem.versionId as string | undefined) : undefined;
    if (id) return go(`/plans/versions/${id}`, { error: message(e) });
    return go('/plans', { error: message(e) });
  }
  return go(`/plans/versions/${r.versionId}`, { ok: `Draft v${r.version} created from the latest version` });
}

/** The builder form: modules, feature switches/limits, setting bounds, add-ons, price. */
export async function saveDraft(f: FormData) {
  const id = str(f, 'versionId');
  const modules = f.getAll('module').map(String);
  const features: Record<string, { enabled: boolean; limit: number | null; overage?: string | null }> = {};
  for (const key of f.getAll('featureKey').map(String)) {
    const limit = str(f, `limit:${key}`);
    const overage = str(f, `overage:${key}`);
    features[key] = { enabled: f.get(`on:${key}`) !== null, limit: limit === '' ? null : Number(limit), ...(overage ? { overage } : {}) };
  }
  const settings: Record<string, { min: number | null; max: number | null }> = {};
  for (const key of f.getAll('settingKey').map(String)) {
    const min = str(f, `min:${key}`);
    const max = str(f, `max:${key}`);
    if (min !== '' || max !== '') settings[key] = { min: min === '' ? null : Number(min), max: max === '' ? null : Number(max) };
  }
  let problems: string[] = [];
  try {
    ({ problems } = await call<{ problems: string[] }>(`/versions/${id}`, 'PUT', {
      listPrice: Number(str(f, 'listPrice') || 0), trialDays: Number(str(f, 'trialDays') || 0), modules, features, settings, addons: f.getAll('addon').map(String),
    }));
  } catch (e) {
    return go(`/plans/versions/${id}`, { error: message(e) });
  }
  return go(`/plans/versions/${id}`, problems.length ? { error: `Saved, but fix before submitting: ${problems.join('; ')}` } : { ok: 'Draft saved' });
}

export async function submitVersion(f: FormData) {
  const id = str(f, 'versionId');
  try {
    await call(`/versions/${id}/submit`, 'POST');
  } catch (e) {
    return go(`/plans/versions/${id}`, { error: message(e) });
  }
  return go(`/plans/versions/${id}`, { ok: 'Submitted: someone else must approve it before it is published' });
}

export async function approveVersion(f: FormData) {
  const id = str(f, 'versionId');
  let r: { moved: string[]; failed: { slug: string; error: string }[] };
  try {
    r = await call(`/versions/${id}/approve`, 'POST', { migration: str(f, 'migration') || 'NEW_ONLY', note: str(f, 'note') || null });
  } catch (e) {
    return go(`/plans/versions/${id}`, { error: message(e) });
  }
  const extra = r.moved.length ? ` ${r.moved.length} hospital(s) moved to it: ${r.moved.join(', ')}.` : '';
  return go(`/plans/versions/${id}`, r.failed.length ? { error: `Published, but could not move: ${r.failed.map((x) => `${x.slug} (${x.error})`).join('; ')}` } : { ok: `Published.${extra}` });
}

export async function rejectVersion(f: FormData) {
  const id = str(f, 'versionId');
  try {
    await call(`/versions/${id}/reject`, 'POST', { note: str(f, 'note') });
  } catch (e) {
    return go(`/plans/versions/${id}`, { error: message(e) });
  }
  return go(`/plans/versions/${id}`, { ok: 'Sent back to draft with your note' });
}

export async function retireVersion(f: FormData) {
  const id = str(f, 'versionId');
  try {
    await call(`/versions/${id}/retire`, 'POST');
  } catch (e) {
    return go(`/plans/versions/${id}`, { error: message(e) });
  }
  return go(`/plans/versions/${id}`, { ok: 'Retired: no longer sold; hospitals on it keep it until moved' });
}

export async function discardDraft(f: FormData) {
  const id = str(f, 'versionId');
  try {
    await call(`/versions/${id}`, 'DELETE');
  } catch (e) {
    return go(`/plans/versions/${id}`, { error: message(e) });
  }
  return go('/plans', { ok: 'Draft discarded' });
}

// ---------- hospitals ----------

const addonsFrom = (f: FormData) => f.getAll('addon').map(String).filter(Boolean).map((code) => ({ code, quantity: Number(str(f, `qty:${code}`) || 1) }));

export async function assignPlan(f: FormData) {
  const id = str(f, 'hospitalId');
  try {
    await call(`/hospitals/${id}/contract`, 'PUT', { plan: str(f, 'plan'), addons: addonsFrom(f), reason: str(f, 'reason') });
  } catch (e) {
    return go(`/hospitals/${id}`, { error: message(e) });
  }
  return go(`/hospitals/${id}`, { ok: `Moved to ${str(f, 'plan')}: modules are switching now` });
}

export async function overrideModule(f: FormData) {
  const id = str(f, 'hospitalId');
  try {
    await call(`/hospitals/${id}/modules/${encodeURIComponent(str(f, 'module'))}`, 'PUT', { state: str(f, 'state'), reason: str(f, 'reason') });
  } catch (e) {
    return go(`/hospitals/${id}`, { error: message(e) });
  }
  return go(`/hospitals/${id}`, { ok: 'Override saved' });
}

export async function overrideFeature(f: FormData) {
  const id = str(f, 'hospitalId');
  const limit = str(f, 'limit');
  const value = f.get('reset') !== null ? null : limit === '' ? { limit: null } : { limit: Number(limit) };
  try {
    await call(`/hospitals/${id}/features/${encodeURIComponent(str(f, 'feature'))}`, 'PUT', { value, reason: str(f, 'reason') });
  } catch (e) {
    return go(`/hospitals/${id}`, { error: message(e) });
  }
  return go(`/hospitals/${id}`, { ok: value ? 'Limit override saved' : 'Back to the plan\'s limit' });
}

// ---------- billing ----------

export async function createCoupon(f: FormData) {
  const pct = str(f, 'percentOff');
  const amt = str(f, 'amountOff');
  try {
    await call('/coupons', 'POST', { code: str(f, 'code'), description: str(f, 'description'), percentOff: pct ? Number(pct) : null, amountOff: amt ? Number(amt) : null, months: str(f, 'months') ? Number(str(f, 'months')) : null, maxRedemptions: str(f, 'maxRedemptions') ? Number(str(f, 'maxRedemptions')) : null });
  } catch (e) {
    return go('/pricebook', { error: message(e) });
  }
  return go('/pricebook', { ok: `Coupon ${str(f, 'code').toUpperCase()} created` });
}

export async function recordOfflinePayment(f: FormData) {
  const id = str(f, 'hospitalId');
  try {
    await call(`/hospitals/${id}/invoices/${str(f, 'invoiceId')}/paid`, 'POST', { reference: str(f, 'reference') });
  } catch (e) {
    return go(`/hospitals/${id}`, { error: message(e) });
  }
  return go(`/hospitals/${id}`, { ok: 'Payment recorded' });
}
