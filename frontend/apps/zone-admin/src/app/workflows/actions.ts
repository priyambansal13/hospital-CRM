'use server';
import { actionSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { redirect } from 'next/navigation';
import { errorText } from '@/lib/directory';

const back = async (q: Record<string, string>) => redirect(`${await origin()}/admin/workflows?${new URLSearchParams(q)}`);
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/** The rule form: up to three condition rows (fact empty = unused) and a tick per action. */
export async function addRule(form: FormData) {
  const { accessToken: token } = await actionSession();
  const trigger = str(form, 'trigger');
  const conditions = [0, 1, 2]
    .map((i) => ({ fact: str(form, `fact${i}`) === '__field' ? `field.${str(form, `field${i}`)}` : str(form, `fact${i}`), op: str(form, `op${i}`), value: str(form, `value${i}`) }))
    .filter((c) => c.fact && c.fact !== 'field.');
  const actions: Record<string, unknown>[] = [];
  if (form.get('a_staff') === 'on') actions.push({ type: 'NOTIFY_STAFF', audience: str(form, 'audience'), subject: str(form, 'staffSubject'), message: str(form, 'staffMessage') });
  if (form.get('a_patient') === 'on') actions.push({ type: 'NOTIFY_PATIENT', subject: str(form, 'patientSubject'), message: str(form, 'patientMessage') });
  if (form.get('a_tag') === 'on') actions.push({ type: 'TAG_PATIENT', tag: str(form, 'tag') });
  if (form.get('a_prepay') === 'on') actions.push({ type: 'REQUIRE_PREPAYMENT', reason: str(form, 'reason') });
  if (form.get('a_clear') === 'on') actions.push({ type: 'CLEAR_PREPAYMENT' });
  try {
    await api('/api/integration/v1/workflows/rules', { token, body: { name: str(form, 'name'), trigger, conditions, actions } });
  } catch (e) {
    return back({ error: errorText(e), trigger });
  }
  return back({ ok: `Added "${str(form, 'name')}"` });
}

export async function toggleRule(form: FormData) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/integration/v1/workflows/rules/${form.get('id')}`, { token, method: 'PATCH', body: { active: form.get('active') === 'true', version: Number(form.get('version')) } });
  } catch (e) {
    return back({ error: errorText(e) });
  }
  return back({ ok: 'Updated' });
}
