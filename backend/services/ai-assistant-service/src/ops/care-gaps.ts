import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EventTypes, type PatientNudge, type TenantPlacement, Topics } from '@mc/contracts';
import { conflict, DomainError, ModuleHooks, PLACEMENTS } from '@mc/nest-common';
import { addToOutbox, type Actor, envelope, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { LLM, type LlmClient } from '../llm/llm.js';
import { BriefService } from './brief.js';

const svc = (name: string, port: number) => process.env[`SVC_URL_${name}`] ?? `http://localhost:${port}`;
const internal = { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' };

/**
 * Care-gap rules (docs/AI-AGENTS.md §7): **rules decide who**, the model only drafts how to say it. The model never
 * sees a patient or a condition: it is asked for one reminder per rule with placeholders, and a person approves the
 * wording before anything is sent. Messages never name the condition (an SMS can be read by others).
 */
export const CARE_GAP_RULES = {
  DIABETES_HBA1C: { label: 'Diabetes: HbA1c every 6 months', diagnoses: ['E10', 'E11', 'E13', 'E14'], tests: ['HBA1C'], testName: 'HbA1c blood test', every: 'every 6 months', withinDays: 182 },
  HYPERTENSION_KIDNEY: { label: 'High blood pressure: kidney function test every year', diagnoses: ['I10', 'I11', 'I12', 'I13', 'I15'], tests: ['KFT'], testName: 'kidney function test', every: 'once a year', withinDays: 365 },
  THYROID_TSH: { label: 'Thyroid conditions: TSH every year', diagnoses: ['E03', 'E05', 'E06'], tests: ['TSH'], testName: 'thyroid (TSH) test', every: 'once a year', withinDays: 365 },
} as const;
export type CareGapRule = keyof typeof CARE_GAP_RULES;
const RULES = Object.keys(CARE_GAP_RULES) as CareGapRule[];
const PLACEHOLDERS = new Set(['patientName', 'hospital', 'link', 'testName']);
const CONDITION_WORDS = /diabet|sugar patient|hypertensi|blood pressure|hypothyroid|hyperthyroid|thyroid (disease|disorder|problem)|disease|disorder|diagnos|your condition|chronic/i;
const RENUDGE_DAYS = 90;
const MAX_PER_RUN = Number(process.env.CARE_GAP_MAX_PER_RUN ?? 300);

const template = (r: CareGapRule) => ({
  subject: 'A check-up reminder from {{hospital}}',
  body: `Hello {{patientName}}, your doctor recommends a {{testName}} ${CARE_GAP_RULES[r].every}, and it is due. You can book it here: {{link}}. Reply or call us if you have questions. – {{hospital}}`,
});

/** Wording a person can approve: known placeholders only, the booking link, short, no condition named. */
export function checkWording(subject: string, body: string): string | null {
  const used = [...`${subject} ${body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
  const bad = used.filter((p) => !PLACEHOLDERS.has(p));
  if (bad.length) return `unknown placeholder ${bad.map((b) => `{{${b}}}`).join(', ')}`;
  if (!body.includes('{{link}}')) return 'the message must include {{link}} (where to book)';
  if (subject.length < 5 || subject.length > 120) return 'the subject is 5 to 120 characters';
  if (body.length < 30 || body.length > 600) return 'the message is 30 to 600 characters';
  if (CONDITION_WORDS.test(`${subject} ${body}`)) return 'the message must not name a condition (others may read an SMS)';
  return null;
}

export const render = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');

const SYSTEM = [
  'You write short, warm reminder messages a hospital sends to its patients by SMS and e-mail, in plain English.',
  'Use these placeholders exactly where needed: {{patientName}}, {{hospital}}, {{testName}}, {{link}} (where to book; always include it).',
  'Never mention any illness, diagnosis or condition, and do not give medical advice: other people may read the message. At most 3 sentences, at most 450 characters, no emojis.',
].join('\n');
const SCHEMA = { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] };

const toMessage = (r: any) => ({
  rule: r.rule as CareGapRule, label: CARE_GAP_RULES[r.rule as CareGapRule]?.label ?? r.rule, testName: CARE_GAP_RULES[r.rule as CareGapRule]?.testName,
  status: r.status, subject: r.subject, body: r.body, source: r.source, note: r.note, model: r.model, approvedAt: r.approved_at, version: r.version,
});

@Injectable()
export class CareGapService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('CareGaps');
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly db: TenantDbRouter, @Inject(LLM) private readonly llm: LlmClient, private readonly briefs: BriefService,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource, hooks: ModuleHooks,
  ) {
    // switching the module on drafts the wording (Batch Mode); nothing is sent until a person approves it
    hooks.register('ai_ops', { enable: async (c) => { const t = TenantContext.require(); await this.ensureRows(c); setImmediate(() => void TenantContext.run(t, () => this.draft()).catch((e) => this.log.warn(`${t.slug}: draft: ${(e as Error).message}`))); } });
  }

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timers.push(setInterval(() => void this.each((t) => this.poll(t)), Number(process.env.BATCH_POLL_MS ?? 60_000)));
    this.timers.push(setInterval(() => void this.each((t) => this.runWeekly(t)), Number(process.env.CARE_GAP_INTERVAL_MS ?? 3_600_000)));
  }
  onApplicationShutdown() { this.timers.forEach(clearInterval); }

  private async each(fn: (t: TenantPlacement) => Promise<unknown>) {
    for (const t of await this.placements.list().catch(() => [])) {
      if (t.status !== 'ACTIVE' || !(await this.briefs.enabled(t.id, 'ai_ops.care_gaps').catch(() => false))) continue;
      await TenantContext.run(t, () => fn(t)).catch((e) => this.log.warn(`${t.slug}: ${(e as Error).message}`));
    }
  }

  private async ensureRows(c: { query: (sql: string, args?: unknown[]) => Promise<unknown> }) {
    for (const r of RULES) await c.query(`INSERT INTO care_gap_messages (rule, status) VALUES ($1, 'DRAFTING') ON CONFLICT (rule) DO NOTHING`, [r]);
  }

  async list() {
    await this.ensureRows(this.db);
    const { rows } = await this.db.query(`SELECT m.*, (SELECT row_to_json(x) FROM (SELECT candidates, nudged, started_at FROM care_gap_runs WHERE rule = m.rule ORDER BY started_at DESC LIMIT 1) x) AS last_run,
      (SELECT count(*)::int FROM care_gap_nudges n WHERE n.rule = m.rule) AS sent FROM care_gap_messages m ORDER BY m.rule`);
    return rows.map((r) => ({ ...toMessage(r), lastRun: r.last_run, sent: r.sent }));
  }

  /** Ask Batch Mode for the wording of every rule not yet approved (one request per rule; no patient data). */
  async draft() {
    await this.ensureRows(this.db);
    const { rows } = await this.db.query(`SELECT rule FROM care_gap_messages WHERE status IN ('DRAFTING','DRAFT') ORDER BY rule`);
    const rules = rows.map((r) => r.rule as CareGapRule);
    if (!rules.length) return { submitted: 0 };
    const job = await this.llm.submitBatch(rules.map((r) => ({
      system: SYSTEM, purpose: 'batch' as const, responseSchema: SCHEMA, thinking: 'low' as const, maxOutputTokens: 400,
      turns: [{ role: 'user' as const, text: `Write the reminder for patients who are due a test.\n<care_gap_rule>${JSON.stringify({ testName: CARE_GAP_RULES[r].testName, every: CARE_GAP_RULES[r].every })}</care_gap_rule>` }],
    })));
    await this.db.query(`INSERT INTO batch_jobs (id, kind, provider_job, items, status) VALUES ($1, 'CARE_GAP_WORDING', $2, $3, 'PENDING')`, [randomUUID(), job, JSON.stringify(rules)]);
    await this.db.query(`UPDATE care_gap_messages SET status = 'DRAFTING', updated_at = now() WHERE rule = ANY($1)`, [rules]);
    await this.poll(TenantContext.require());
    return { submitted: rules.length };
  }

  /** Collect finished Batch Mode jobs: checked wording becomes a DRAFT; anything else falls back to the template. */
  async poll(_t: TenantPlacement) {
    const { rows: jobs } = await this.db.query(`SELECT * FROM batch_jobs WHERE status = 'PENDING' ORDER BY created_at`);
    for (const j of jobs) {
      const st = await this.llm.batchStatus(j.provider_job).catch((e) => ({ state: 'PENDING' as const, results: [], error: (e as Error).message }));
      if (st.state === 'PENDING') continue;
      const rules = j.items as CareGapRule[];
      await this.db.tx(async (c) => {
        for (const [i, rule] of rules.entries()) {
          const out = st.results[i];
          let w = template(rule);
          let source: 'AI' | 'TEMPLATE' = 'TEMPLATE';
          let note: string | null = st.state === 'FAILED' ? `Batch job failed (${st.error ?? 'no reason'}); standard wording` : 'No answer for this rule; standard wording';
          if (out?.text) {
            try {
              const p = JSON.parse(out.text) as { subject?: string; body?: string };
              const problem = p.subject && p.body ? checkWording(p.subject.trim(), p.body.trim()) : 'empty answer';
              if (problem) note = `The drafted wording was not usable (${problem}); standard wording`;
              else { w = { subject: p.subject!.trim(), body: p.body!.trim() }; source = 'AI'; note = null; }
            } catch { note = 'The drafted wording was not JSON; standard wording'; }
          }
          await c.query(`UPDATE care_gap_messages SET status = 'DRAFT', subject = $2, body = $3, source = $4, note = $5, model = $6, version = version + 1, updated_at = now() WHERE rule = $1 AND status = 'DRAFTING'`,
            [rule, w.subject, w.body, source, note, out?.model ?? null]);
        }
        await c.query(`UPDATE batch_jobs SET status = $2, error = $3, finished_at = now() WHERE id = $1`, [j.id, st.state === 'SUCCEEDED' ? 'DONE' : 'FAILED', st.error ?? null]);
      });
    }
  }

  /** A person approves (possibly edited) wording, or switches a rule off. */
  async update(actor: Actor, rule: CareGapRule, v: { subject?: string; body?: string; status: 'APPROVED' | 'OFF' | 'DRAFT'; version: number }) {
    return this.db.tx(async (c) => {
      const { rows: [m] } = await c.query('SELECT * FROM care_gap_messages WHERE rule = $1 FOR UPDATE', [rule]);
      if (!m) throw new DomainError(404, 'NOT_FOUND', 'care-gap rule not found');
      if (m.version !== v.version) throw conflict('VERSION_CONFLICT', 'this message changed in another window; reload');
      const subject = v.subject?.trim() ?? m.subject;
      const body = v.body?.trim() ?? m.body;
      if (v.status === 'APPROVED') {
        if (!subject || !body) throw new DomainError(422, 'NO_WORDING', 'the wording is still being drafted');
        const problem = checkWording(subject, body);
        if (problem) throw new DomainError(422, 'BAD_WORDING', problem);
      }
      const edited = subject !== m.subject || body !== m.body;
      const { rows: [r] } = await c.query(
        `UPDATE care_gap_messages SET status = $2, subject = $3, body = $4, source = CASE WHEN $5 THEN 'EDITED' ELSE source END,
           approved_by = CASE WHEN $2 = 'APPROVED' THEN $6::uuid ELSE NULL END, approved_at = CASE WHEN $2 = 'APPROVED' THEN now() ELSE NULL END, version = version + 1, updated_at = now()
         WHERE rule = $1 RETURNING *`, [rule, v.status, subject, body, edited, actor.id]);
      return toMessage(r);
    });
  }

  private async runWeekly(t: TenantPlacement) {
    const { rows } = await this.db.query(`SELECT rule FROM care_gap_messages m WHERE status = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM care_gap_runs r WHERE r.rule = m.rule AND r.started_at > now() - interval '7 days')`);
    for (const r of rows) await this.run(t, r.rule as CareGapRule);
  }

  /** One rule now: who is due (records + diagnostics), minus those reminded in the last 90 days; one message each. */
  async run(t: TenantPlacement, rule: CareGapRule) {
    const def = CARE_GAP_RULES[rule];
    const { rows: [m] } = await this.db.query(`SELECT * FROM care_gap_messages WHERE rule = $1`, [rule]);
    if (m?.status !== 'APPROVED') throw new DomainError(422, 'NOT_APPROVED', 'approve the wording before sending reminders');
    const res = await fetch(`${svc('RECORDS', 4410)}/internal/tenants/${t.id}/care-gaps/candidates?codes=${def.diagnoses.join(',')}`, { headers: internal, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`records-service ${res.status}`);
    const candidates = (await res.json()) as { patientId: string; accountPersonId: string; name: string }[];
    let tested = new Map<string, string>();
    if (candidates.length) {
      const r2 = await fetch(`${svc('DIAGNOSTICS', 4412)}/internal/tenants/${t.id}/care-gaps/last-tests`, {
        method: 'POST', headers: { ...internal, 'content-type': 'application/json' }, body: JSON.stringify({ patientIds: candidates.map((c) => c.patientId), testCodes: def.tests }), signal: AbortSignal.timeout(20_000),
      });
      if (!r2.ok) throw new Error(`diagnostics-service ${r2.status}`);
      tested = new Map(((await r2.json()) as { patientId: string; lastAt: string }[]).map((x) => [x.patientId, x.lastAt]));
    }
    const due = candidates.filter((c) => { const last = tested.get(c.patientId); return !last || Date.now() - Date.parse(last) > def.withinDays * 86_400_000; });
    return this.db.tx(async (c) => {
      const { rows: recent } = await c.query(`SELECT DISTINCT patient_id FROM care_gap_nudges WHERE rule = $1 AND sent_at > now() - make_interval(days => $2)`, [rule, RENUDGE_DAYS]);
      const skip = new Set(recent.map((r) => r.patient_id as string));
      const send = due.filter((d) => !skip.has(d.patientId)).slice(0, MAX_PER_RUN);
      const runId = randomUUID();
      for (const p of send) {
        const id = randomUUID();
        await c.query(`INSERT INTO care_gap_nudges (id, rule, patient_id, account_person_id, run_id) VALUES ($1,$2,$3,$4,$5)`, [id, rule, p.patientId, p.accountPersonId, runId]);
        const vars = { patientName: p.name.split(' ')[0] ?? p.name, hospital: t.name, testName: def.testName, link: '{{link}}' };
        const data: PatientNudge = { nudgeId: id, kind: 'CARE_GAP', accountPersonId: p.accountPersonId, subject: render(m.subject, vars).slice(0, 150), message: render(m.body, vars).slice(0, 1000) };
        await addToOutbox(c, Topics.assistant, p.accountPersonId, envelope(EventTypes.patientNudge, data, { tenantId: t.id, subject: id }));
      }
      await c.query(`INSERT INTO care_gap_runs (id, rule, candidates, nudged) VALUES ($1,$2,$3,$4)`, [runId, rule, due.length, send.length]);
      this.log.log(`${t.slug}: ${rule}: ${due.length} due, ${send.length} reminded`);
      return { rule, due: due.length, reminded: send.length, skippedRecent: due.length - send.length };
    });
  }
}
