'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { redirect } from 'next/navigation';

/**
 * Finish a visit whose note is not signed yet, on purpose: the note stays in "Unsigned notes" until the doctor signs it
 * (docs/ROLE-FLOWS-AND-GAPS.md C-4). Plain "Complete visit" is refused while the note is open.
 */
export async function finishSignLater(f: FormData) {
  const { accessToken: token } = await actionSession();
  let q: Record<string, string>;
  try {
    const a = await api<{ patient: { name: string } }>(`/api/scheduling/v1/appointments/${encodeURIComponent(String(f.get('id')))}/complete`, { token, body: { allowUnsigned: true } });
    q = { ok: `Visit with ${a.patient.name} completed. Sign the note from "Unsigned notes".` };
  } catch (e) {
    q = { error: e instanceof ApiError ? e.message : 'Something went wrong' };
  }
  redirect(`${await origin()}/doctor/queue?${new URLSearchParams(q)}`);
}
