import type { TenantPlacement as Tenant } from '@mc/contracts';
import type { Actor } from '@mc/tenancy';
import { asUser, localDate } from '../chat/tools.js';

/**
 * The facts a pre-visit summary may use (docs/AI-AGENTS.md §5.1), read WITH THE DOCTOR'S OWN TOKEN from the services
 * that own them, so their access rules (treating relationship, consent, break-glass) and audit apply. Each fact gets
 * a short reference (E1 = a visit, P1 = a prescription, A1 = an allergy, L1 = a lab report, T1 = today's triage);
 * the summary must cite them, and the citation check drops any line that does not.
 */
export type SourceType = 'ENCOUNTER' | 'PRESCRIPTION' | 'ALLERGY' | 'LAB_REPORT' | 'TRIAGE';
export interface Source { ref: string; type: SourceType; id: string; date: string | null }
export interface Facts {
  patient: { id: string; name: string; age: number | null; gender: string | null };
  appointment: { id: string; date: string | null; reason: string | null };
  today: string;
  /** ref → the fact itself (what the model may say, and what the citation check compares numbers with) */
  facts: Record<string, Record<string, unknown>>;
  sources: Source[];
}

type Enc = { id: string; appointmentId: string | null; status: string; startedAt: string; signedAt: string | null; doctor: { name: string }; chiefComplaint: string | null; diagnoses: { code: string; description: string; isPrimary: boolean }[]; vitals: Record<string, unknown> | null;
  prescriptions: { id: string; prescriptionNo: string; issuedAt: string; followUpOn: string | null; advice: string | null; items: { drugName: string; strength: string | null; form: string | null; dosage: string; durationDays: number | null; instructions: string | null }[] }[] };
type Param = { parameter: string; unit: string | null; refLow: number | null; refHigh: number | null; value: string | null; flag: string | null };
type Sheet = { order: { id: string; orderNo: string; status: string }; collectedAt: string | null; tests: { name: string; parameters: Param[] }[] };

const day = (v: string | null | undefined) => (v ? localDate(new Date(v)) : null);
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))) as T;

export async function gatherFacts(actor: Actor, tenant: Tenant, appointmentId: string): Promise<Facts> {
  const ctx = { actor, tenant };
  const appt = await asUser<{ id: string; patient: { id: string; name: string }; localDate: string | null; reason: string | null }>(ctx, 'scheduling', `/v1/appointments/${appointmentId}`);
  const pid = appt.patient.id;
  // the chart decides access (treating doctor, consent or break-glass); without it there is no summary
  const chart = await asUser<{ patient: { id: string; name: string; age: number | null; gender: string | null }; encounters: Enc[] }>(ctx, 'records', `/v1/patients/${pid}/chart`);
  const [allergies, triage, timeline] = await Promise.all([
    asUser<{ id: string; substance: string; severity: string; reaction: string | null; createdAt: string }[]>(ctx, 'patient', `/v1/patients/${pid}/allergies`).catch(() => []),
    asUser<{ triage: { priority: string; chiefComplaint: string | null; vitals: Record<string, unknown> | null; recordedAt: string } | null }>(ctx, 'records', `/v1/appointments/${appointmentId}/triage`).catch(() => ({ triage: null })),
    asUser<{ items: { kind: string; refId: string; occurredAt: string }[] }>(ctx, 'records', `/v1/patients/${pid}/timeline?kind=LAB_ORDER`).catch(() => ({ items: [] })),
  ]);
  const sheets = (await Promise.all(timeline.items.filter((i) => i.kind === 'LAB_ORDER').slice(0, 6).map((i) =>
    asUser<Sheet>(ctx, 'diagnostics', `/v1/doctor/lab-orders/${i.refId}/results`).catch(() => null)))).filter((x): x is Sheet => !!x && x.order.status === 'REPORT_PUBLISHED').slice(0, 4);

  const facts: Facts['facts'] = {};
  const sources: Source[] = [];
  const add = (prefix: string, type: SourceType, id: string, date: string | null, fact: Record<string, unknown>) => {
    const ref = `${prefix}${sources.filter((s) => s.ref.startsWith(prefix)).length + 1}`;
    facts[ref] = clean({ date, ...fact });
    sources.push({ ref, type, id, date });
    return ref;
  };

  if (triage.triage) add('T', 'TRIAGE', appointmentId, day(triage.triage.recordedAt), { priority: triage.triage.priority, complaint: triage.triage.chiefComplaint, vitals: triage.triage.vitals ? clean(triage.triage.vitals) : null });
  // earlier visits (not this one), newest first: what was found and what was prescribed
  for (const e of chart.encounters.filter((x) => x.appointmentId !== appointmentId && x.status !== 'OPEN').slice(0, 5)) {
    add('E', 'ENCOUNTER', e.id, day(e.signedAt ?? e.startedAt), { doctor: e.doctor.name, complaint: e.chiefComplaint, diagnoses: e.diagnoses.map((d) => `${d.description} (${d.code})${d.isPrimary ? ', primary' : ''}`) });
    for (const p of e.prescriptions) {
      const longest = Math.max(0, ...p.items.map((i) => i.durationDays ?? 0));
      const until = p.issuedAt ? localDate(new Date(new Date(p.issuedAt).getTime() + longest * 86_400_000)) : null;
      add('P', 'PRESCRIPTION', p.id, day(p.issuedAt), {
        prescriptionNo: p.prescriptionNo, medicines: p.items.map((i) => [i.drugName, i.strength, i.form, i.dosage, i.durationDays ? `${i.durationDays} days` : null, i.instructions].filter(Boolean).join(' ')),
        coversUntil: until, stillCurrent: until != null && until >= localDate(), advice: p.advice, followUpOn: p.followUpOn,
      });
    }
  }
  for (const a of allergies) add('A', 'ALLERGY', a.id, day(a.createdAt), { substance: a.substance, severity: a.severity, reaction: a.reaction });
  for (const s of sheets) {
    const values = s.tests.flatMap((t) => t.parameters.filter((p) => p.value != null).map((p) => clean({
      test: t.name, name: p.parameter, value: p.value, unit: p.unit, normalRange: p.refLow != null && p.refHigh != null ? `${p.refLow}-${p.refHigh}` : null, flag: p.flag ?? 'NORMAL',
    })));
    add('L', 'LAB_REPORT', s.order.id, day(s.collectedAt), { orderNo: s.order.orderNo, values });
  }
  return {
    patient: { id: pid, name: chart.patient.name, age: chart.patient.age, gender: chart.patient.gender },
    appointment: { id: appointmentId, date: appt.localDate, reason: appt.reason },
    today: localDate(), facts, sources,
  };
}
