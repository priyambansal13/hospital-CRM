'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/**
 * Amend a signed visit (E-9): the complaint, notes and diagnoses can be corrected, with a reason; only what changed is
 * sent, so the amendment lists exactly the fields that were corrected.
 */
export async function amendVisitFull(f: FormData) {
  const s = (k: string) => String(f.get(k) ?? '').trim();
  const path = s('back');
  const before = JSON.parse(s('before') || '{}') as { chiefComplaint: string | null; notes: string | null; diagnoses: { code: string | null; description: string; isPrimary: boolean }[] };
  const rows = Number(f.get('dxRows') ?? 0);
  const primary = s('dxPrimary');
  const diagnoses = [];
  for (let i = 0; i < rows; i++) {
    if (f.get(`dxKeep${i}`) !== 'on') continue;
    const code = s(`dxCode${i}`).toUpperCase() || null;
    const description = s(`dxDesc${i}`) || null;
    if (!code && !description) continue;
    diagnoses.push({ code, description, isPrimary: primary === String(i) });
  }
  if (diagnoses.length && !diagnoses.some((d) => d.isPrimary)) diagnoses[0].isPrimary = true;
  const body: Record<string, unknown> = { reason: s('reason') };
  if ((s('chiefComplaint') || null) !== (before.chiefComplaint || null)) body.chiefComplaint = s('chiefComplaint') || null;
  if ((s('notes') || null) !== (before.notes || null)) body.notes = s('notes') || null;
  const key = (l: { code: string | null; description: string | null; isPrimary: boolean }[]) => JSON.stringify(l.map((d) => [d.code, d.code ? null : d.description, d.isPrimary]));
  if (key(diagnoses) !== key(before.diagnoses ?? [])) body.diagnoses = diagnoses;
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    if (Object.keys(body).length === 1) throw new Error('change something first');
    await api(`/api/records/v1/encounters/${encodeURIComponent(s('encounterId'))}/amendments`, { token, body });
    q = { ok: 'Amendment saved' };
  } catch (e) {
    q = { error: e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join('; ') || e.message) : (e as Error).message };
  }
  redirect(`${await origin()}${path.startsWith('/doctor/') ? path : '/doctor/queue'}?${new URLSearchParams(q)}`);
}
