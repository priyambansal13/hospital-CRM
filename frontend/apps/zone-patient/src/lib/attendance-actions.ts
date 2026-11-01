'use server';
import { actionSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import { errorText } from './booking';

/** "I'm coming" (Phase 29): the answer to the hospital's evening-before message. */
export async function confirmAttendance(f: FormData) {
  const s = await actionSession();
  const back = async (q: Record<string, string>) => redirect(`${await origin()}/care/appointments?${new URLSearchParams(q)}`);
  if (s.kind !== 'patient') return back({ error: 'Sign in as a patient.' });
  try {
    await api(`/api/scheduling/v1/appointments/${f.get('id')}/attendance`, { token: s.accessToken, method: 'POST' });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: 'Thank you: the hospital knows you are coming.' });
}
