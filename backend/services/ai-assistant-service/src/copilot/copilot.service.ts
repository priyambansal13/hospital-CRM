import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { DomainError, FieldCrypto, forbidden, notFound } from '@mc/nest-common';
import { type Actor, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { ToolError } from '../chat/tools.js';
import { LLM, type LlmClient } from '../llm/llm.js';
import { gatherFacts, type Source } from './facts.js';
import { checkCitations, SUMMARY_PROMPT, SUMMARY_SCHEMA, SUMMARY_SYSTEM, summaryTurn, type Summary } from './summary.js';

export interface DraftView {
  id: string; appointmentId: string; patientId: string; createdAt: string; model: string | null;
  sections: Summary['sections']; sources: Source[]; droppedLines: number;
  feedback: { rating: 1 | -1; reason: string | null } | null;
}

/**
 * The doctor's copilot (docs/AI-AGENTS.md §5, IMPLEMENTATION-PLAN.md Phase 24): a pre-visit summary from the record,
 * every line citing the record it came from. It is a draft for the doctor's eyes, never part of the medical record;
 * the records it reads are read with the doctor's own token (their access rules and audit apply).
 */
@Injectable()
export class CopilotService {
  private readonly log = new Logger('Copilot');

  constructor(private readonly db: TenantDbRouter, private readonly crypto: FieldCrypto, private readonly entitlements: EntitlementsClient, @Inject(LLM) private readonly llm: LlmClient) {}

  private aad = (id: string) => `assistant.clinical_drafts:${id}`;

  private async allowed(actor: Actor) {
    if (actor.kind !== 'staff') throw forbidden('STAFF_ONLY', 'the copilot is for doctors');
    const caps = await this.entitlements.capabilities(TenantContext.require().id, { id: actor.id, kind: actor.kind });
    if (!caps.features['ai.copilot']?.enabled) throw forbidden('FEATURE_NOT_IN_PLAN', 'the doctor copilot is not in this hospital\'s plan');
  }

  async generate(actor: Actor, appointmentId: string): Promise<DraftView> {
    await this.allowed(actor);
    const t = TenantContext.require();
    let facts;
    try {
      facts = await gatherFacts(actor, t, appointmentId);
    } catch (e) {
      // the owning service said no (not the treating doctor, no such appointment): pass its answer on
      if (e instanceof ToolError) throw new DomainError((e as { status?: number }).status ?? 502, (e as { code?: string }).code ?? 'UPSTREAM', e.message);
      throw e;
    }
    const started = Date.now();
    let raw: unknown = null;
    let out;
    try {
      out = await this.llm.generate({ purpose: 'copilot', system: SUMMARY_SYSTEM, turns: [{ role: 'user', text: summaryTurn(facts) }], responseSchema: SUMMARY_SCHEMA, thinking: 'medium', maxOutputTokens: 1500, timeoutMs: 40_000 });
      raw = JSON.parse(out.text || 'null');
    } catch (e) {
      this.log.warn(`${t.slug}: summary failed: ${(e as Error).message}`);
      throw new DomainError(503, 'COPILOT_UNAVAILABLE', 'the summary could not be made just now; try again');
    }
    const { summary, dropped } = checkCitations(raw, facts.facts);
    if (dropped) this.log.warn(`${t.slug}: ${dropped} summary line(s) dropped by the citation check (appointment ${appointmentId})`);
    const used = new Set(summary.sections.flatMap((s) => s.lines.flatMap((l) => l.refs)));
    const sources = facts.sources.filter((s) => used.has(s.ref));
    const id = randomUUID();
    await this.db.tx(async (c) => {
      await c.query(`UPDATE clinical_drafts SET status = 'SUPERSEDED' WHERE appointment_id = $1 AND doctor_user_id = $2 AND status = 'DRAFT'`, [appointmentId, actor.id]);
      await c.query(
        `INSERT INTO clinical_drafts (id, kind, appointment_id, patient_id, doctor_user_id, draft_enc, sources, dropped_lines, model, prompt_version, input_tokens, output_tokens, latency_ms)
         VALUES ($1,'PREVISIT_SUMMARY',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, appointmentId, facts.patient.id, actor.id, await this.crypto.encrypt(t.id, this.aad(id), JSON.stringify(summary)), JSON.stringify(sources), dropped,
          out.model, SUMMARY_PROMPT.version, out.usage.input, out.usage.output, Date.now() - started]);
    });
    return (await this.latest(actor, appointmentId))!;
  }

  /** The doctor's latest summary for this appointment (each doctor sees only their own). */
  async latest(actor: Actor, appointmentId: string): Promise<DraftView | null> {
    if (actor.kind !== 'staff') throw forbidden('STAFF_ONLY', 'the copilot is for doctors');
    const t = TenantContext.require();
    const { rows: [d] } = await this.db.query(`SELECT * FROM clinical_drafts WHERE appointment_id = $1 AND doctor_user_id = $2 AND status = 'DRAFT' ORDER BY created_at DESC LIMIT 1`, [appointmentId, actor.id]);
    if (!d) return null;
    const summary = JSON.parse((await this.crypto.decrypt(t.id, this.aad(d.id), d.draft_enc)) ?? '{"sections":[]}') as Summary;
    return {
      id: d.id, appointmentId: d.appointment_id, patientId: d.patient_id, createdAt: d.created_at, model: d.model, sections: summary.sections, sources: d.sources, droppedLines: d.dropped_lines,
      feedback: d.rating ? { rating: d.rating, reason: d.feedback_reason } : null,
    };
  }

  /** Thumbs up/down (and why) on a summary: the quality signal for prompt and model changes. */
  async feedback(actor: Actor, draftId: string, v: { rating: 1 | -1; reason?: string | null; comment?: string | null }) {
    const t = TenantContext.require();
    const comment = v.comment?.trim() ? await this.crypto.encrypt(t.id, `assistant.clinical_drafts.feedback:${draftId}`, v.comment.trim()) : null;
    const { rowCount } = await this.db.query(`UPDATE clinical_drafts SET rating = $3, feedback_reason = $4, feedback_comment_enc = $5, feedback_at = now() WHERE id = $1 AND doctor_user_id = $2`,
      [draftId, actor.id, v.rating, v.reason ?? null, comment]);
    if (!rowCount) throw notFound('summary');
  }
}
