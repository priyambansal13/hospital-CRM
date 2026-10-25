'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/home-collection?${new URLSearchParams(q)}`);

/** Add a pincode, or change its branch, fee or availability (same call: pincodes are unique). */
export async function saveArea(f: FormData) {
  const { accessToken: token } = await actionSession();
  const pincode = String(f.get('pincode') ?? '').trim();
  try {
    await api('/api/diagnostics/v1/admin/home-areas', {
      token, body: { pincode, branchId: String(f.get('branchId')), area: String(f.get('area') ?? '').trim() || null, fee: Number(f.get('fee') || 0), active: f.get('active') !== null || f.get('isNew') === '1' },
    });
  } catch (e) {
    return back({ error: e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : 'Could not save' });
  }
  return back({ ok: `${pincode} saved` });
}
