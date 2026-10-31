import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntitlementsClient, UsageMeter } from '@mc/entitlements-sdk';
import { conflict, DomainError, FieldCrypto, forbidden, notFound, REDIS, type Redis } from '@mc/nest-common';
import type { TenantPlacement as Tenant } from '@mc/contracts';
import { type Actor, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { KbService } from '../kb/kb.service.js';
import { LLM, type LlmClient, type ToolResult, type Turn } from '../llm/llm.js';
import { checkEmergency, detectLanguage, emergencyReply, type EmergencyCategory } from '../safety/emergency.js';
import { blockedReply, checkOutput } from '../safety/output-policy.js';
import { conciergeSystem, EMERGENCY_MARK, NO_ANSWER, PROMPTS, userTurn } from './prompts.js';
import { asPatient, type FamilyMember, localDate, type Proposal, ToolError, toolsFor } from './tools.js';

type Kind = 'TEXT' | 'ANSWER' | 'EMERGENCY' | 'BLOCKED' | 'FALLBACK' | 'HANDOFF' | 'LIMIT' | 'ACTION';
/** A Confirm card (the model proposed it; only the patient's tap runs it). */
export interface ActionCard {
  id: string; type: string; status: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'EXPIRED' | 'FAILED';
  title: string; lines: string[]; confirmLabel: string; expiresAt: string; result: { appointmentNo?: string; error?: string } | null;
}
export interface ChatMessage {
  id: string; role: 'user' | 'assistant'; kind: Kind; text: string; sources: { id: string; title: string }[]; cards: ActionCard[];
  /** show "Talk to a person" prominently under this answer */
  offerHandoff: boolean; emergency: EmergencyCategory | 'MODEL' | null; createdAt: string;
}

const MAX_CHARS = 1000;
const HISTORY_TURNS = 6;
/** tool rounds per message before giving up (then: offer a person) */
const MAX_STEPS = 6;
const ACTION_TTL_MIN = 15;
const WEEKDAY = (iso: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
const RATE = { max: Number(process.env.ASSISTANT_RATE_MAX ?? 30), windowSec: 600 };
const T = {
  fallback: { en: 'Sorry, I can\'t answer right now. Tap "Talk to a person" and our team will call you back.', hi: 'माफ़ कीजिए, मैं अभी जवाब नहीं दे पा रहा। "किसी व्यक्ति से बात करें" दबाएँ, हमारी टीम आपको कॉल करेगी।' },
  limit: { en: 'The assistant has reached this month\'s message limit for the hospital. Tap "Talk to a person" and our team will call you back.', hi: 'इस महीने के लिए सहायक की संदेश सीमा पूरी हो गई है। "किसी व्यक्ति से बात करें" दबाएँ।' },
  handoff: { en: 'Thanks. Someone from {hospital} will call you{phone} soon. For anything urgent, call the hospital directly.', hi: 'धन्यवाद। {hospital} से कोई जल्द ही आपको{phone} कॉल करेगा।' },
  critical: { en: 'Your report {no} has a result your doctor needs to look at first. The lab has told your doctor, who will contact you. If you feel unwell now, call 112 or come to the emergency department.', hi: 'आपकी रिपोर्ट {no} में एक ऐसा नतीजा है जिसे पहले आपके डॉक्टर देखेंगे। लैब ने आपके डॉक्टर को बता दिया है, वे आपसे संपर्क करेंगे। अभी तबीयत ठीक न लगे तो 112 पर कॉल करें या इमरजेंसी में आएँ।' },
  steps: { en: 'Sorry, I could not finish that. Tap "Talk to a person" and our team will help.', hi: 'माफ़ कीजिए, मैं यह पूरा नहीं कर पाया। "किसी व्यक्ति से बात करें" दबाएँ।' },
};
const say = (k: keyof typeof T, lang: string) => (lang === 'hi' ? T[k].hi : T[k].en);

/**
 * The Care Concierge turn (docs/AI-AGENTS.md §8.2), knowledge-only for Phase 22:
 *   emergency rules (code, before anything else) → monthly quota → the hospital's knowledge → the model → emergency
 *   marker from the model (layer 2) → output policy → stored encrypted.
 * The model never sees patient records; it gets the question, the last few turns and the matching hospital facts.
 */
@Injectable()
export class ChatService {
  private readonly log = new Logger('Concierge');

  constructor(
    private readonly db: TenantDbRouter, private readonly kb: KbService, private readonly crypto: FieldCrypto, private readonly meter: UsageMeter, private readonly entitlements: EntitlementsClient,
    @Inject(LLM) private readonly llm: LlmClient, @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private aad = (id: string) => `assistant.messages:${id}`;

  private async conversation(c: Queryable, actor: Actor, id: string | undefined, language: string) {
    if (id) {
      const { rows: [cv] } = await c.query('SELECT * FROM conversations WHERE id = $1 FOR UPDATE', [id]);
      if (!cv || cv.user_id !== actor.id) throw notFound('conversation');
      if (cv.status === 'CLOSED') throw new DomainError(409, 'CONVERSATION_CLOSED', 'this chat is closed; start a new one');
      return cv;
    }
    const { rows: [cv] } = await c.query(`INSERT INTO conversations (id, user_id, language, prompt_version) VALUES ($1,$2,$3,$4) RETURNING *`, [randomUUID(), actor.id, language, PROMPTS.concierge.version]);
    return cv;
  }

  private async append(c: Queryable, conversationId: string, m: { role: 'user' | 'assistant'; kind: Kind; text: string; sources?: unknown[]; safety?: unknown; model?: string; finishReason?: string; usage?: { input: number; output: number; cached: number }; latencyMs?: number; trace?: Turn[] }) {
    const t = TenantContext.require();
    const id = randomUUID();
    const { rows: [r] } = await c.query(
      `INSERT INTO messages (id, conversation_id, seq, role, kind, content_enc, sources, safety, model, finish_reason, input_tokens, output_tokens, cached_tokens, latency_ms, trace_enc)
       VALUES ($1,$2,(SELECT coalesce(max(seq),0)+1 FROM messages WHERE conversation_id = $2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING created_at`,
      [id, conversationId, m.role, m.kind, await this.crypto.encrypt(t.id, this.aad(id), m.text), JSON.stringify(m.sources ?? []), m.safety ? JSON.stringify(m.safety) : null,
        m.model ?? null, m.finishReason ?? null, m.usage?.input ?? null, m.usage?.output ?? null, m.usage?.cached ?? null, m.latencyMs ?? null,
        m.trace?.length ? await this.crypto.encrypt(t.id, `assistant.messages.trace:${id}`, JSON.stringify(m.trace)) : null]);
    await c.query('UPDATE conversations SET last_activity_at = now() WHERE id = $1', [conversationId]);
    return { id, createdAt: r.created_at };
  }

  private async rateLimit(actor: Actor) {
    const key = `ai:rate:${TenantContext.require().id}:${actor.id}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, RATE.windowSec);
    if (n > RATE.max) throw new DomainError(429, 'TOO_MANY_MESSAGES', 'too many messages; please wait a few minutes');
  }

  async send(actor: Actor, input: { conversationId?: string; text: string }) {
    const t = TenantContext.require();
    const text = input.text.trim();
    if (!text || text.length > MAX_CHARS) throw new DomainError(400, 'BAD_MESSAGE', `a message is 1 to ${MAX_CHARS} characters`);
    await this.rateLimit(actor);
    const language = detectLanguage(text);

    // 1. user message stored first (a crash later still leaves the question on record)
    const { cv, user } = await this.db.tx(async (c) => {
      const cv = await this.conversation(c, actor, input.conversationId, language);
      return { cv, user: await this.append(c, cv.id, { role: 'user', kind: 'TEXT', text }) };
    });
    const proposed: string[] = [];
    const toolLog: { step: number; name: string; input: Record<string, unknown>; summary: unknown; error: boolean; ms: number }[] = [];
    const reply = (m: Omit<ChatMessage, 'id' | 'role' | 'createdAt' | 'cards'> & { safety?: unknown; model?: string; finishReason?: string; usage?: { input: number; output: number; cached: number }; latencyMs?: number; trace?: Turn[]; withCards?: boolean }) =>
      this.db.tx(async (c) => {
        const saved = await this.append(c, cv.id, { role: 'assistant', ...m });
        // the cards proposed in this turn belong to this answer (an emergency or a refusal shows none, and they lapse)
        if (proposed.length) {
          if (m.withCards) await c.query('UPDATE pending_actions SET message_id = $2 WHERE id = ANY($1::uuid[])', [proposed, saved.id]);
          else await c.query(`UPDATE pending_actions SET status = 'EXPIRED', decided_at = now() WHERE id = ANY($1::uuid[])`, [proposed]);
        }
        for (const l of toolLog) {
          await c.query('INSERT INTO tool_calls (id, conversation_id, message_id, step, tool_name, input, result_summary, is_error, latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [randomUUID(), cv.id, saved.id, l.step, l.name, JSON.stringify(l.input), JSON.stringify(l.summary), l.error, l.ms]);
        }
        const cards = m.withCards && proposed.length ? await this.cards(c, [saved.id]) : new Map<string, ActionCard[]>();
        return { conversationId: cv.id, userMessageId: user.id, message: { id: saved.id, role: 'assistant' as const, kind: m.kind, text: m.text, sources: m.sources, cards: cards.get(saved.id) ?? [], offerHandoff: m.offerHandoff, emergency: m.emergency, createdAt: saved.createdAt } };
      });

    // 2. emergencies: fixed reply, no model, not counted
    const hit = checkEmergency(text);
    if (hit) {
      this.log.warn(`${t.slug}: emergency rule ${hit.category} (conversation ${cv.id})`);
      return reply({ kind: 'EMERGENCY', text: emergencyReply(hit.category, language, await this.kb.emergencyInfo()), sources: [], offerHandoff: false, emergency: hit.category, safety: { emergency: hit.category, layer: 1 } });
    }

    // 3. the hospital's monthly allowance: one message counts once, however many tool steps it takes
    const r = await this.meter.reserve(t.id, 'ai.concierge', 1);
    if (!r.allowed) return reply({ kind: 'LIMIT', text: say('limit', language), sources: [], offerHandoff: true, emergency: null });

    // 4. knowledge, who is asking, and only the tools this patient may use here (plan, modules, roles) → the model
    const caps = await this.entitlements.capabilities(t.id, { id: actor.id, kind: actor.kind });
    const tools = toolsFor(caps);
    const byName = new Map(tools.map((x) => [x.decl.name, x]));
    const family = tools.length ? await this.family(actor, t) : [];
    const ctx = { actor, tenant: t, family, propose: (p: Proposal) => this.propose(cv.id, actor, p).then((id) => { proposed.push(id); return id; }) };
    const hits = await this.kb.search(text);
    const entries = hits.map((h, i) => ({ n: i + 1, title: h.title, text: h.text }));
    const today = localDate();
    const turns: Turn[] = [...(await this.history(cv.id, user.id)), { role: 'user', text: userTurn(entries, text, tools.length ? { today, weekday: WEEKDAY(today), family } : undefined) }];
    const system = conciergeSystem(t.name, { canBook: byName.has('propose_booking'), canExplain: byName.has('explain_report') });
    const trace: Turn[] = [];
    const usage = { input: 0, output: 0, cached: 0 };
    const started = Date.now();
    let out: Awaited<ReturnType<LlmClient['generate']>> | null = null;
    let wantsPerson = false;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        out = await this.llm.generate({ system, turns: [...turns, ...trace], tools: tools.map((x) => x.decl), thinking: 'low', maxOutputTokens: 600, timeoutMs: 20_000 });
        usage.input += out.usage.input; usage.output += out.usage.output; usage.cached += out.usage.cached;
        if (!out.calls.length) break;
        trace.push({ role: 'model', calls: out.calls, raw: out.raw });
        const results: ToolResult[] = await Promise.all(out.calls.map(async (call) => {
          const tool = byName.get(call.name);
          const begun = Date.now();
          let response: Record<string, unknown>;
          try {
            response = tool ? await tool.run(call.args, ctx) : { error: 'UNKNOWN_TOOL', message: `no tool ${call.name}` };
          } catch (e) {
            // a failed tool is a result the model can read, never a crash; no internal details
            response = { error: (e as { code?: string }).code ?? 'FAILED', message: e instanceof ToolError ? e.message : 'that did not work, try again or offer a person' };
          }
          if (call.name === 'handoff_to_human') wantsPerson = true;
          const { reason: _r, ...safeArgs } = call.args;
          toolLog.push({ step, name: call.name, input: safeArgs, summary: summarise(response), error: 'error' in response, ms: Date.now() - begun });
          return { id: call.id, name: call.name, response };
        }));
        trace.push({ role: 'user', results });
        // a critical lab value: a fixed reply, the model never explains it (the lab calls the doctor first)
        const held = results.find((x) => x.name === 'explain_report' && x.response.criticalHeld === true);
        if (held) {
          this.log.log(`${t.slug}: report with a critical value not explained (conversation ${cv.id})`);
          return reply({ kind: 'ANSWER', text: say('critical', language).replace('{no}', String(held.response.orderNo ?? '')), sources: [], offerHandoff: true, emergency: null, safety: { criticalHeld: true }, model: out.model, usage, latencyMs: Date.now() - started, trace });
        }
        // layer 2 from the model's own triage: same fixed emergency reply, nothing booked
        if (results.some((x) => x.name === 'triage_symptoms' && x.response.urgency === 'EMERGENCY')) {
          this.log.warn(`${t.slug}: triage said EMERGENCY (conversation ${cv.id})`);
          return reply({ kind: 'EMERGENCY', text: emergencyReply('MODEL', language, await this.kb.emergencyInfo()), sources: [], offerHandoff: false, emergency: 'MODEL', safety: { emergency: 'MODEL', layer: 2 }, model: out.model, usage, latencyMs: Date.now() - started });
        }
        out = null;
      }
    } catch (e) {
      await this.meter.release(t.id, 'ai.concierge', 1);
      this.log.warn(`${t.slug}: model call failed: ${(e as Error).message}`);
      return reply({ kind: 'FALLBACK', text: say('fallback', language), sources: [], offerHandoff: true, emergency: null, model: this.llm.chatModel, finishReason: 'ERROR', latencyMs: Date.now() - started });
    }
    if (!out) {
      this.log.warn(`${t.slug}: still calling tools after ${MAX_STEPS} steps (conversation ${cv.id})`);
      return reply({ kind: 'FALLBACK', text: say('steps', language), sources: [], offerHandoff: true, emergency: null, model: this.llm.chatModel, finishReason: 'STEPS', usage, latencyMs: Date.now() - started });
    }
    const meta = { model: out.model, finishReason: out.finishReason, usage, latencyMs: Date.now() - started };
    const answer = out.text.trim();
    if (!answer || out.finishReason === 'SAFETY' || out.finishReason === 'BLOCKED') {
      return reply({ kind: 'FALLBACK', text: say('fallback', language), sources: [], offerHandoff: true, emergency: null, ...meta });
    }
    // layer 2: the model recognised an emergency the rules did not
    if (answer.startsWith(EMERGENCY_MARK)) {
      this.log.warn(`${t.slug}: model flagged an emergency (conversation ${cv.id})`);
      return reply({ kind: 'EMERGENCY', text: emergencyReply('MODEL', language, await this.kb.emergencyInfo()), sources: [], offerHandoff: false, emergency: 'MODEL', safety: { emergency: 'MODEL', layer: 2 }, ...meta });
    }
    const noAnswer = answer.startsWith(NO_ANSWER);
    const shown = (noAnswer ? answer.slice(NO_ANSWER.length) : answer).trim();
    const policy = checkOutput(shown);
    if (!policy.ok) {
      this.log.warn(`${t.slug}: answer blocked by output policy ${policy.rules.join(',')} (conversation ${cv.id})`);
      return reply({ kind: 'BLOCKED', text: blockedReply(language), sources: [], offerHandoff: true, emergency: null, safety: { blocked: policy.rules }, ...meta });
    }
    const cited = [...new Set([...shown.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].map((n) => hits[n - 1]).filter(Boolean);
    return reply({
      kind: 'ANSWER', text: shown.replace(/\s*\[\d+\](?:\s*\[\d+\])*/g, '').trim(), sources: cited.map((h) => ({ id: h.articleId, title: h.title })),
      offerHandoff: noAnswer || wantsPerson, emergency: null, safety: noAnswer ? { noAnswer: true } : null, trace, withCards: true, ...meta,
    });
  }

  /** The patient and the family members they may book for (from patient-service, with their token). */
  private async family(actor: Actor, t: Tenant): Promise<FamilyMember[]> {
    const list = await asPatient<{ id: string; fullName: string; relation: string; isSelf: boolean }[]>({ actor, tenant: t }, 'patient', '/v1/me/patients').catch(() => []);
    return list.map((p) => ({ id: p.id, name: p.fullName, relation: p.relation, isSelf: p.isSelf }));
  }

  /** A Confirm card: stored now, shown with the answer, run only by the patient's tap (within 15 minutes). */
  private async propose(conversationId: string, actor: Actor, p: Proposal) {
    const id = randomUUID();
    await this.db.query(`INSERT INTO pending_actions (id, conversation_id, user_id, action_type, payload, card, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7))`,
      [id, conversationId, actor.id, p.type, JSON.stringify(p.payload), JSON.stringify(p.card), ACTION_TTL_MIN]);
    return id;
  }

  /** Cards per message (their current status). */
  private async cards(c: Queryable, messageIds: string[]): Promise<Map<string, ActionCard[]>> {
    const out = new Map<string, ActionCard[]>();
    if (!messageIds.length) return out;
    const { rows } = await c.query(`SELECT * FROM pending_actions WHERE message_id = ANY($1::uuid[]) ORDER BY created_at`, [messageIds]);
    for (const a of rows) {
      if (!out.has(a.message_id)) out.set(a.message_id, []);
      out.get(a.message_id)!.push(toCard(a));
    }
    return out;
  }

  /**
   * The last few turns. An answer that used tools brings its calls and results back too, so "the second one"
   * still means the second time it offered. Emergencies and refusals are not fed back to the model.
   */
  private async history(conversationId: string, excludeId: string): Promise<Turn[]> {
    const t = TenantContext.require();
    const { rows } = await this.db.query(`SELECT id, role, content_enc, trace_enc FROM messages WHERE conversation_id = $1 AND id <> $2 AND kind IN ('TEXT','ANSWER','ACTION') ORDER BY seq DESC LIMIT $3`, [conversationId, excludeId, HISTORY_TURNS]);
    const turns: Turn[] = [];
    for (const r of rows.reverse()) {
      if (r.trace_enc) turns.push(...(JSON.parse((await this.crypto.decrypt(t.id, `assistant.messages.trace:${r.id}`, r.trace_enc)) ?? '[]') as Turn[]));
      turns.push({ role: r.role === 'user' ? 'user' : 'model', text: (await this.crypto.decrypt(t.id, this.aad(r.id), r.content_enc)) ?? '' });
    }
    // a conversation must start with the user (a trimmed window can begin mid-way)
    while (turns.length && (turns[0].role === 'model' || turns[0].results)) turns.shift();
    return turns;
  }

  // ---------- Confirm cards ----------

  private async action(c: Queryable, actor: Actor, id: string) {
    const { rows: [a] } = await c.query('SELECT * FROM pending_actions WHERE id = $1 FOR UPDATE', [id]);
    if (!a || a.user_id !== actor.id) throw notFound('action');
    if (a.status === 'PENDING' && new Date(a.expires_at).getTime() < Date.now()) {
      await c.query(`UPDATE pending_actions SET status = 'EXPIRED', decided_at = now() WHERE id = $1`, [id]);
      a.status = 'EXPIRED';
    }
    return a;
  }

  /**
   * The patient tapped Confirm: run the real action through the owning service with THEIR token (same rules, same
   * audit as the app's own buttons). The card id is the idempotency key, so a double tap books once.
   */
  async confirm(actor: Actor, id: string) {
    const t = TenantContext.require();
    return this.db.tx(async (c) => {
      const a = await this.action(c, actor, id);
      if (a.status === 'CONFIRMED') return { action: toCard(a), message: null };
      if (a.status !== 'PENDING') throw conflict(`ACTION_${a.status}`, a.status === 'EXPIRED' ? 'this card has expired: ask again for a fresh one' : `this card is ${a.status.toLowerCase()}`);
      const ctx = { actor, tenant: t };
      const p = a.payload;
      let status: 'CONFIRMED' | 'FAILED' = 'CONFIRMED';
      let result: Record<string, unknown>;
      let text: string;
      try {
        if (a.action_type === 'BOOK_APPOINTMENT') {
          const appt = await asPatient<{ id: string; appointmentNo: string; doctor: { name: string }; localDate: string; localTime: string; branch: { name: string } }>(ctx, 'scheduling', '/v1/appointments', {
            body: { slotId: p.slotId, patientId: p.patientId, reason: p.reason ?? null, paymentMode: 'AT_CLINIC' }, headers: { 'idempotency-key': a.id, 'x-mc-via': 'ASSISTANT' },
          });
          result = { appointmentId: appt.id, appointmentNo: appt.appointmentNo };
          text = `Booked. Your appointment number is ${appt.appointmentNo}${appt.doctor ? ` with ${appt.doctor.name}` : ''}${appt.localDate ? ` on ${appt.localDate} at ${appt.localTime}` : ''}. Pay at the hospital. You can see it under "My appointments".`;
        } else if (a.action_type === 'CANCEL_APPOINTMENT') {
          const appt = await asPatient<{ appointmentNo: string }>(ctx, 'scheduling', `/v1/appointments/${p.appointmentId}/cancel`, { body: { reason: 'Cancelled in the assistant chat' } });
          result = { appointmentNo: appt.appointmentNo };
          text = `Cancelled appointment ${appt.appointmentNo}. If you paid online, the refund goes back to how you paid.`;
        } else {
          const appt = await asPatient<{ appointmentNo: string; localDate?: string; localTime?: string }>(ctx, 'scheduling', `/v1/appointments/${p.appointmentId}/reschedule`, { body: { newSlotId: p.newSlotId } });
          result = { appointmentNo: appt.appointmentNo };
          text = `Moved. Your new appointment number is ${appt.appointmentNo}.`;
        }
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        status = 'FAILED';
        const code = (e as { code?: string }).code ?? 'FAILED';
        result = { error: code };
        text = code === 'SLOT_UNAVAILABLE' ? 'Sorry, that time was just taken by someone else. Ask me for other times.' : `That did not go through: ${e.message}`;
      }
      const { rows: [u] } = await c.query(`UPDATE pending_actions SET status = $2, result = $3, decided_at = now() WHERE id = $1 RETURNING *`, [id, status, JSON.stringify(result)]);
      const saved = await this.append(c, a.conversation_id, { role: 'assistant', kind: 'ACTION', text });
      this.log.log(`${t.slug}: ${a.action_type} ${status.toLowerCase()} from the assistant (conversation ${a.conversation_id})`);
      return { action: toCard(u), message: { id: saved.id, role: 'assistant' as const, kind: 'ACTION' as const, text, sources: [], cards: [], offerHandoff: status === 'FAILED', emergency: null, createdAt: saved.createdAt } };
    });
  }

  /** "Not now": the card is closed and nothing changes. */
  async reject(actor: Actor, id: string) {
    return this.db.tx(async (c) => {
      const a = await this.action(c, actor, id);
      if (a.status !== 'PENDING') return { action: toCard(a) };
      const { rows: [u] } = await c.query(`UPDATE pending_actions SET status = 'REJECTED', decided_at = now() WHERE id = $1 RETURNING *`, [id]);
      return { action: toCard(u) };
    });
  }

  async messages(conversationId: string): Promise<ChatMessage[]> {
    const t = TenantContext.require();
    const { rows } = await this.db.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY seq', [conversationId]);
    const cards = await this.cards(await this.db.current(), rows.filter((m) => m.kind === 'ANSWER').map((m) => m.id));
    return Promise.all(rows.map(async (m) => ({
      id: m.id, role: m.role, kind: m.kind, text: (await this.crypto.decrypt(t.id, this.aad(m.id), m.content_enc)) ?? '', sources: m.sources, cards: cards.get(m.id) ?? [],
      offerHandoff: ['LIMIT', 'FALLBACK', 'BLOCKED'].includes(m.kind) || !!m.safety?.noAnswer, emergency: m.safety?.emergency ?? null, createdAt: m.created_at,
    })));
  }

  async own(actor: Actor, conversationId: string) {
    const { rows: [cv] } = await this.db.query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
    if (!cv || cv.user_id !== actor.id) throw notFound('conversation');
    return cv;
  }

  /** The patient's latest open chat (to continue where they left off), with its messages. */
  async latest(actor: Actor) {
    const { rows: [cv] } = await this.db.query(`SELECT * FROM conversations WHERE user_id = $1 AND status <> 'CLOSED' AND last_activity_at > now() - interval '7 days' ORDER BY last_activity_at DESC LIMIT 1`, [actor.id]);
    if (!cv) return { conversation: null, messages: [] };
    return { conversation: toConversation(cv, await this.openHandoff(cv.id)), messages: await this.messages(cv.id) };
  }

  async close(actor: Actor, conversationId: string) {
    await this.own(actor, conversationId);
    await this.db.query(`UPDATE conversations SET status = 'CLOSED' WHERE id = $1`, [conversationId]);
  }

  async feedback(actor: Actor, messageId: string, v: { rating: 1 | -1; reason?: string | null }) {
    const { rows: [m] } = await this.db.query(`SELECT m.id, c.user_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1 AND m.role = 'assistant'`, [messageId]);
    if (!m || m.user_id !== actor.id) throw notFound('message');
    await this.db.query(`INSERT INTO feedback (message_id, user_id, rating, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (message_id) DO UPDATE SET rating = $3, reason = $4, created_at = now()`, [messageId, actor.id, v.rating, v.reason ?? null]);
  }

  // ---------- human handoff ----------

  private async openHandoff(conversationId: string) {
    const { rows: [h] } = await this.db.query(`SELECT * FROM handoffs WHERE conversation_id = $1 AND status = 'OPEN'`, [conversationId]);
    return h ?? null;
  }

  /** "Talk to a person": the front desk sees the chat and calls back. Name and phone come from the patient's own profile. */
  async handoff(actor: Actor, conversationId: string, v: { reason: 'ASKED' | 'NO_ANSWER' | 'EMERGENCY' | 'LIMIT' | 'FALLBACK'; phone?: string | null }) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'only patients hand a chat over');
    const t = TenantContext.require();
    const cv = await this.own(actor, conversationId);
    const existing = await this.openHandoff(cv.id);
    if (existing) return { handoff: toHandoff(existing), message: null };
    const me = await fetch(`${process.env.SVC_URL_PATIENT ?? 'http://localhost:4406'}/v1/me/patients`, { headers: { authorization: `Bearer ${actor.token}`, 'x-tenant-host': t.hosts[0] } })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []) as { fullName: string; phone: string | null; isSelf: boolean }[];
    const self = me.find((p) => p.isSelf) ?? me[0];
    const phone = v.phone?.trim() || self?.phone || null;
    const lang = cv.language;
    return this.db.tx(async (c) => {
      const { rows: [h] } = await c.query(`INSERT INTO handoffs (id, conversation_id, user_id, name, phone, reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [randomUUID(), cv.id, actor.id, self?.fullName ?? 'Patient', phone, v.reason]);
      await c.query(`UPDATE conversations SET status = 'HANDED_OFF' WHERE id = $1`, [cv.id]);
      const text = say('handoff', lang).replace('{hospital}', t.name).replace('{phone}', phone ? ` on ${phone}` : '');
      const saved = await this.append(c, cv.id, { role: 'assistant', kind: 'HANDOFF', text });
      return { handoff: toHandoff(h), message: { id: saved.id, role: 'assistant', kind: 'HANDOFF', text, sources: [], cards: [], offerHandoff: false, emergency: null, createdAt: saved.createdAt } };
    });
  }

  async handoffs(status: 'OPEN' | 'DONE') {
    // open ones: emergencies first, then oldest first (review: desk alerts for chat requests)
    const { rows } = await this.db.query(`SELECT * FROM handoffs WHERE status = $1 ORDER BY ${status === 'OPEN' ? "(reason = 'EMERGENCY') DESC, created_at ASC" : 'created_at DESC'} LIMIT 100`, [status]);
    return Promise.all(rows.map(async (h) => ({ ...toHandoff(h), transcript: (await this.messages(h.conversation_id)).map((m) => ({ role: m.role, kind: m.kind, text: m.text, at: m.createdAt })) })));
  }

  /** For the desk's alert banner (polled): how many are waiting, how many are emergencies, the oldest wait. No names. */
  async handoffSummary() {
    const { rows: [r] } = await this.db.query(`SELECT count(*)::int AS open, count(*) FILTER (WHERE reason = 'EMERGENCY')::int AS emergency, min(created_at) AS oldest FROM handoffs WHERE status = 'OPEN'`);
    return { open: r.open, emergency: r.emergency, oldestAt: r.oldest, oldestMinutes: r.oldest ? Math.floor((Date.now() - new Date(r.oldest).getTime()) / 60_000) : null };
  }

  async closeHandoff(staffId: string, id: string, note: string | null) {
    const { rows: [h] } = await this.db.query(`UPDATE handoffs SET status = 'DONE', closed_by = $2, closed_at = now(), note = $3 WHERE id = $1 AND status = 'OPEN' RETURNING *`, [id, staffId, note]);
    if (!h) throw notFound('open chat request');
    await this.db.query(`UPDATE conversations SET status = 'CLOSED' WHERE id = $1`, [h.conversation_id]);
    return toHandoff(h);
  }
}

const toConversation = (c: any, h: any) => ({ id: c.id, status: c.status, language: c.language, createdAt: c.created_at, handoff: h ? toHandoff(h) : null });
const toHandoff = (h: any) => ({ id: h.id, conversationId: h.conversation_id, name: h.name, phone: h.phone, reason: h.reason, status: h.status, createdAt: h.created_at, closedAt: h.closed_at, note: h.note });

const toCard = (a: any): ActionCard => {
  const expired = a.status === 'PENDING' && new Date(a.expires_at).getTime() < Date.now();
  return { id: a.id, type: a.action_type, status: expired ? 'EXPIRED' : a.status, title: a.card.title, lines: a.card.lines, confirmLabel: a.card.confirmLabel, expiresAt: a.expires_at, result: a.result ?? null };
};

/** What the tool log keeps of a result: its shape, never names or times. */
function summarise(r: Record<string, unknown>) {
  if ('error' in r) return { error: r.error };
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v === 'object' && v !== null ? 'object' : k.endsWith('Id') ? v : typeof v]));
}
