'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError, origin } from '@mc/bff';
import { valuesFromForm } from '@mc/forms';
import { redirect } from 'next/navigation';

const errorText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => `${x.path || 'form'}: ${x.message}`).join('; ') || e.message) : 'Something went wrong');

/** Custom fields on a patient or one of their appointments (Phase 27); back to the patient's page. */
export async function saveCustomFields(f: FormData) {
  const { accessToken: token } = await actionSession();
  const patientId = String(f.get('patientId'));
  const apptId = String(f.get('appointmentId') ?? '');
  const path = apptId ? `/api/scheduling/v1/appointments/${encodeURIComponent(apptId)}/custom-fields` : `/api/patient/v1/patients/${encodeURIComponent(patientId)}/custom-fields`;
  let q: Record<string, string>;
  try {
    await api(path, { token, method: 'PUT', body: { values: valuesFromForm(f), version: Number(f.get('version')) } });
    q = { ok: 'Saved' };
  } catch (e) {
    q = { error: errorText(e) };
  }
  redirect(`${await origin()}/desk/patients/${encodeURIComponent(patientId)}?${new URLSearchParams(q)}`);
}
