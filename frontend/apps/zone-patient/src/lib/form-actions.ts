'use server';
import { actionSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { valuesFromForm } from '@mc/forms';
import { redirect } from 'next/navigation';
import { errorText } from './booking';

/** The patient's answers to the pre-visit form (Phase 27). */
export async function answerForm(f: FormData) {
  const { accessToken: token } = await actionSession();
  const id = encodeURIComponent(String(f.get('appointmentId')));
  try {
    await api(`/api/scheduling/v1/appointments/${id}/form`, { token, method: 'PUT', body: { answers: valuesFromForm(f) } });
  } catch (e) {
    redirect(`${await origin()}/care/appointments/${id}/form?${new URLSearchParams({ error: errorText(e) })}`);
  }
  redirect(`${await origin()}/care/appointments?${new URLSearchParams({ ok: 'Thank you: the doctor will see your answers' })}`);
}
