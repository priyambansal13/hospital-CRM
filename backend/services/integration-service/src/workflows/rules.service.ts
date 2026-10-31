import { Injectable, Logger } from '@nestjs/common';
import { AppointmentChanged, type EventEnvelope, EventTypes, LabCriticalValue, LabReportPublished, PatientRegistered, Topics, type WorkflowNotify } from '@mc/contracts';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { conflict, DomainError, notFound } from '@mc/nest-common';
import { addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash, randomUUID } from 'node:crypto';
import { type Action, allHold, type Facts, render, type RuleInput, type Trigger, triggerOf } from './engine.js';

const svc = (name: string, port: number) => process.env[`SVC_URL_${name}`] ?? `http://localhost:${port}`;
const internal = () => ({ 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '', 'content-type': 'application/json' });
/** the same rule and event always give the same run id (a redelivered event never notifies twice) */
const runIdOf = (ruleId: string, eventId: string) => {
  const h = createHash('sha256').update(`${ruleId}:${eventId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const toRule = (r: any) => ({ id: r.id, name: r.name, trigger: r.trigger as Trigger, conditions: r.conditions, actions: r.actions as Action[], active: r.active, version: r.version, createdAt: r.created_at });

interface Subject { patientId: string; accountPersonId: string | null; branchId: string | null; label: string; vars: Record<string, unknown>; facts: Facts }

/**
 * Workflow rules (Phase 27). Every appointment / lab / patient event first updates the patient's counters (so the
 * first rule written already sees the history since the module was switched on), then each active rule for that
 * trigger is evaluated once per event (rule_runs); matching rules run their actions inside the event's transaction:
 * notices go out through the outbox, tags and the prepayment flag are idempotent calls, so a retried event is safe.
 */
@Injectable()
export class RulesService {
  private readonly log = new Logger('Workflows');
  constructor(private readonly db: TenantDbRouter, private readonly entitlements: EntitlementsClient) {}

  async list() {
    const { rows } = await this.db.query('SELECT * FROM rules ORDER BY created_at');
    return rows.map(toRule);
  }

  async runs(limit = 50) {
    const { rows } = await this.db.query(`SELECT r.*, u.name AS rule_name FROM rule_runs r JOIN rules u ON u.id = r.rule_id WHERE r.matched ORDER BY r.created_at DESC LIMIT $1`, [limit]);
    return rows.map((r) => ({ id: r.id, ruleId: r.rule_id, ruleName: r.rule_name, trigger: r.trigger, subject: r.subject, results: r.results, at: r.created_at }));
  }

  private async limit(c: Queryable, excludingId: string | null) {
    const f = (await this.entitlements.tenantFeatures(TenantContext.require().id)).features['workflows.rules'];
    if (f?.limit == null) return;
    const { rows: [r] } = await c.query(`SELECT count(*)::int n FROM rules WHERE active AND ($1::uuid IS NULL OR id <> $1)`, [excludingId]);
    if (r.n >= f.limit) throw new DomainError(422, 'LIMIT_REACHED', `your plan allows ${f.limit} active workflow rules: switch one off first`, { limit: f.limit });
  }

  async create(v: RuleInput) {
    return this.db.tx(async (c) => {
      await this.limit(c, null);
      const { rows: [r] } = await c.query('INSERT INTO rules (id, name, trigger, conditions, actions) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [randomUUID(), v.name, v.trigger, JSON.stringify(v.conditions), JSON.stringify(v.actions)]);
      return toRule(r);
    });
  }

  async update(id: string, v: Partial<RuleInput> & { active?: boolean; version: number }) {
    return this.db.tx(async (c) => {
      const { rows: [r0] } = await c.query('SELECT * FROM rules WHERE id = $1 FOR UPDATE', [id]);
      if (!r0) throw notFound('workflow rule');
      if (r0.version !== v.version) throw conflict('VERSION_CONFLICT', 'this rule changed in another window; reload');
      if (v.active === true && !r0.active) await this.limit(c, id);
      const { rows: [r] } = await c.query(
        `UPDATE rules SET name = coalesce($2, name), trigger = coalesce($3, trigger), conditions = coalesce($4, conditions), actions = coalesce($5, actions), active = coalesce($6, active), version = version + 1 WHERE id = $1 RETURNING *`,
        [id, v.name ?? null, v.trigger ?? null, v.conditions ? JSON.stringify(v.conditions) : null, v.actions ? JSON.stringify(v.actions) : null, v.active ?? null]);
      return toRule(r);
    });
  }

  // ---------- events ----------

  async onEvent(c: Queryable, e: EventEnvelope) {
    const subject = await this.subjectOf(c, e);
    if (!subject) return;
    const triggers = triggerOf(e.type);
    const { rows: rules } = await c.query('SELECT * FROM rules WHERE active AND trigger = ANY($1) ORDER BY created_at', [triggers]);
    if (!rules.length) return;
    const t = TenantContext.require();
    if ((await this.entitlements.moduleState(t.id, 'workflows')) !== 'ACTIVE') return;
    // patient facts only when a rule needs them (one call per event)
    const needsPatient = rules.some((r) => (r.conditions as { fact: string }[]).some((x) => x.fact === 'tags' || x.fact.startsWith('field.'))) || rules.some((r) => (r.actions as Action[]).some((a) => a.type === 'NOTIFY_PATIENT')) && !subject.accountPersonId;
    if (needsPatient) await this.addPatient(t.id, subject);
    subject.vars.hospital = t.name;
    for (const r of rules) {
      const { rowCount } = await c.query('INSERT INTO rule_runs (id, rule_id, event_id, trigger, subject, matched) VALUES ($1,$2,$3,$4,$5,false) ON CONFLICT (rule_id, event_id) DO NOTHING', [runIdOf(r.id, e.id), r.id, e.id, r.trigger, subject.label]);
      if (!rowCount || !allHold(r.conditions, subject.facts)) continue;
      const results: { action: string; ok: boolean; detail: string }[] = [];
      for (const a of r.actions as Action[]) results.push({ action: a.type, ...(await this.act(c, t.id, r.id, runIdOf(r.id, e.id), a, subject)) });
      await c.query('UPDATE rule_runs SET matched = true, results = $2 WHERE rule_id = $1 AND event_id = $3', [r.id, JSON.stringify(results), e.id]);
    }
  }

  /** What the event is about, its facts and message variables; appointment events also move the patient's counters. */
  private async subjectOf(c: Queryable, e: EventEnvelope): Promise<Subject | null> {
    switch (e.type) {
      case EventTypes.appointmentNoShow: case EventTypes.appointmentCancelled: case EventTypes.appointmentCompleted: case EventTypes.appointmentBooked: {
        const a = AppointmentChanged.parse(e.data);
        const col = ({ [EventTypes.appointmentNoShow]: 'no_shows', [EventTypes.appointmentCancelled]: 'cancellations', [EventTypes.appointmentCompleted]: 'completed' } as Record<string, string>)[e.type];
        const { rows: [n] } = col
          ? await c.query(`INSERT INTO patient_counters (patient_id, ${col}) VALUES ($1, 1) ON CONFLICT (patient_id) DO UPDATE SET ${col} = patient_counters.${col} + 1, updated_at = now() RETURNING *`, [a.patientId])
          : await c.query(`INSERT INTO patient_counters (patient_id) VALUES ($1) ON CONFLICT (patient_id) DO UPDATE SET updated_at = now() RETURNING *`, [a.patientId]);
        return {
          patientId: a.patientId, accountPersonId: a.accountPersonId, branchId: a.branchId, label: `${a.appointmentNo} · ${a.patientName ?? a.patientMrn ?? ''}`,
          facts: { noShows: n.no_shows, cancellations: n.cancellations, completedVisits: n.completed, doctorName: a.doctorName, branchName: a.branchName, mode: a.mode, source: a.source, paymentMode: a.paymentMode, fee: a.fee ?? null },
          vars: { patientName: a.patientName, mrn: a.patientMrn, appointmentNo: a.appointmentNo, doctorName: a.doctorName, branchName: a.branchName, date: a.localDate, time: a.localTime, noShows: n.no_shows },
        };
      }
      case EventTypes.labCriticalValue: {
        const a = LabCriticalValue.parse(e.data);
        return { patientId: a.patientId, accountPersonId: null, branchId: a.branchId ?? null, label: `${a.orderNo} · ${a.patientName}`, facts: { testName: a.testName, parameter: a.parameter }, vars: { patientName: a.patientName, mrn: a.patientMrn, orderNo: a.orderNo, testName: a.testName, parameter: a.parameter } };
      }
      case EventTypes.labReportPublished: {
        const a = LabReportPublished.parse(e.data);
        return { patientId: a.patientId, accountPersonId: a.accountPersonId, branchId: null, label: `${a.orderNo} · ${a.patientName}`, facts: { abnormalCount: a.abnormalCount, criticalCount: a.criticalCount }, vars: { patientName: a.patientName, mrn: a.patientMrn, orderNo: a.orderNo } };
      }
      case EventTypes.patientRegistered: {
        const a = PatientRegistered.parse(e.data);
        const age = a.dob ? Math.floor((Date.now() - Date.parse(`${a.dob}T00:00:00Z`)) / (365.25 * 86_400_000)) : null;
        return { patientId: a.patientId, accountPersonId: a.accountPersonId, branchId: null, label: `${a.mrn} · ${a.name}`, facts: { age, gender: a.gender }, vars: { patientName: a.name, mrn: a.mrn } };
      }
      default: return null;
    }
  }

  private async addPatient(tenantId: string, s: Subject) {
    const res = await fetch(`${svc('PATIENT', 4406)}/internal/tenants/${tenantId}/patients/${s.patientId}`, { headers: internal(), signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`patient-service ${res.status}`); // retried with the event
    const p = (await res.json()) as { accountPersonId: string; tags: string[]; customFields: Record<string, unknown> };
    s.accountPersonId ??= p.accountPersonId;
    s.facts.tags = p.tags ?? [];
    for (const [k, v] of Object.entries(p.customFields ?? {})) s.facts[`field.${k}`] = v as Facts[string];
  }

  private async act(c: Queryable, tenantId: string, ruleId: string, runId: string, a: Action, s: Subject): Promise<{ ok: boolean; detail: string }> {
    const vars = { ...s.facts, ...s.vars };
    const notify = async (n: Omit<WorkflowNotify, 'ruleId' | 'runId'>) => {
      await addToOutbox(c, Topics.integration, s.patientId, envelope(EventTypes.workflowNotify, { ruleId, runId, ...n } satisfies WorkflowNotify, { tenantId, subject: runId }));
    };
    switch (a.type) {
      case 'NOTIFY_STAFF':
        await notify({ audience: 'STAFF', permission: a.audience, branchId: s.branchId, accountPersonId: null, subject: render(a.subject, vars).slice(0, 150), message: render(a.message, vars).slice(0, 1000) });
        return { ok: true, detail: `e-mail to ${a.audience}` };
      case 'NOTIFY_PATIENT':
        if (!s.accountPersonId) return { ok: false, detail: 'no patient account' };
        await notify({ audience: 'PATIENT', permission: null, branchId: s.branchId, accountPersonId: s.accountPersonId, subject: render(a.subject, vars).slice(0, 150), message: render(a.message, vars).slice(0, 1000) });
        return { ok: true, detail: 'message to the patient' };
      case 'TAG_PATIENT': {
        const res = await fetch(`${svc('PATIENT', 4406)}/internal/tenants/${tenantId}/patients/${s.patientId}/tags`, { method: 'POST', headers: internal(), body: JSON.stringify({ tag: a.tag }), signal: AbortSignal.timeout(5000) });
        if (!res.ok && res.status !== 404) throw new Error(`patient-service ${res.status}`);
        return { ok: res.ok, detail: res.ok ? `tagged "${a.tag}"` : 'patient not found' };
      }
      case 'REQUIRE_PREPAYMENT': case 'CLEAR_PREPAYMENT': {
        const required = a.type === 'REQUIRE_PREPAYMENT';
        const res = await fetch(`${svc('SCHEDULING', 4405)}/internal/tenants/${tenantId}/patients/${s.patientId}/prepayment`, { method: 'POST', headers: internal(), body: JSON.stringify({ required, reason: required ? a.reason : null, ruleId }), signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`scheduling-service ${res.status}`);
        return { ok: true, detail: required ? 'must pay online when booking' : 'may pay at the hospital again' };
      }
    }
  }
}
