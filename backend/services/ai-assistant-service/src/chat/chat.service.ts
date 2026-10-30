import { Inject, Injectable, Logger } from '@nestjs/common';
import { UsageMeter } from '@mc/entitlements-sdk';
import { DomainError, FieldCrypto, forbidden, notFound, REDIS, type Redis } from '@mc/nest-common';
import { type Actor, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { KbService } from '../kb/kb.service.js';
import { LLM, type LlmClient, type Turn } from '../llm/llm.js';
import { checkEmergency, detectLanguage, emergencyReply, type EmergencyCategory } from '../safety/emergency.js';
import { blockedReply, checkOutput } from '../safety/output-policy.js';
import { conciergeSystem, EMERGENCY_MARK, NO_ANSWER, PROMPTS, userTurn } from './prompts.js';

type Kind = 'TEXT' | 'ANSWER' | 'EMERGENCY' | 'BLOCKED' | 'FALLBACK' | 'HANDOFF' | 'LIMIT';
export interface ChatMessage {
  id: string; role: 'user' | 'assistant'; kind: Kind; text: string; sources: { id: string; title: string }[];
  /** show "Talk to a person" prominently under this answer */
  offerHandoff: boolean; emergency: EmergencyCategory | 'MODEL' | null; createdAt: string;
}

const MAX_CHARS = 1000;
const HISTORY_TURNS = 6;
const RATE = { max: Number(process.env.ASSISTANT_RATE_MAX ?? 30), windowSec: 600 };
const T = {
  fallback: { en: 'Sorry, I can\'t answer right now. Tap "Talk to a person" and our team will call you back.', hi: 'माफ़ कीजिए, मैं अभी जवाब नहीं दे पा रहा। "किसी व्यक्ति से बात करें" दबाएँ, हमारी टीम आपको कॉल करेगी।' },
  limit: { en: 'The assistant has reached this month\'s message limit for the hospital. Tap "Talk to a person" and our team will call you back.', hi: 'इस महीने के लिए सहायक की संदेश सीमा पूरी हो गई है। "किसी व्यक्ति से बात करें" दबाएँ।' },
  handoff: { en: 'Thanks. Someone from {hospital} will call you{phone} soon. For anything urgent, call the hospital directly.', hi: 'धन्यवाद। {hospital} से कोई जल्द ही आपको{phone} कॉल करेगा।' },
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
    private readonly db: TenantDbRouter, private readonly kb: KbService, private readonly crypto: FieldCrypto, private readonly meter: UsageMeter,
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

  private async append(c: Queryable, conversationId: string, m: { role: 'user' | 'assistant'; kind: Kind; text: string; sources?: unknown[]; safety?: unknown; model?: string; finishReason?: string; usage?: { input: number; output: number; cached: number }; latencyMs?: number }) {
    const t = TenantContext.require();
    const id = randomUUID();
    const { rows: [r] } = await c.query(
      `INSERT INTO messages (id, conversation_id, seq, role, kind, content_enc, sources, safety, model, finish_reason, input_tokens, output_tokens, cached_tokens, latency_ms)
       VALUES ($1,$2,(SELECT coalesce(max(seq),0)+1 FROM messages WHERE conversation_id = $2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING created_at`,
      [id, conversationId, m.role, m.kind, await this.crypto.encrypt(t.id, this.aad(id), m.text), JSON.stringify(m.sources ?? []), m.safety ? JSON.stringify(m.safety) : null,
        m.model ?? null, m.finishReason ?? null, m.usage?.input ?? null, m.usage?.output ?? null, m.usage?.cached ?? null, m.latencyMs ?? null]);
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
    const reply = (m: Omit<ChatMessage, 'id' | 'role' | 'createdAt'> & { safety?: unknown; model?: string; finishReason?: string; usage?: { input: number; output: number; cached: number }; latencyMs?: number }) =>
      this.db.tx(async (c) => {
        const saved = await this.append(c, cv.id, { role: 'assistant', ...m });
        return { conversationId: cv.id, userMessageId: user.id, message: { id: saved.id, role: 'assistant' as const, kind: m.kind, text: m.text, sources: m.sources, offerHandoff: m.offerHandoff, emergency: m.emergency, createdAt: saved.createdAt } };
      });

    // 2. emergencies: fixed reply, no model, not counted
    const hit = checkEmergency(text);
    if (hit) {
      this.log.warn(`${t.slug}: emergency rule ${hit.category} (conversation ${cv.id})`);
      return reply({ kind: 'EMERGENCY', text: emergencyReply(hit.category, language, await this.kb.emergencyInfo()), sources: [], offerHandoff: false, emergency: hit.category, safety: { emergency: hit.category, layer: 1 } });
    }

    // 3. the hospital's monthly allowance
    const r = await this.meter.reserve(t.id, 'ai.concierge', 1);
    if (!r.allowed) return reply({ kind: 'LIMIT', text: say('limit', language), sources: [], offerHandoff: true, emergency: null });

    // 4. knowledge + history → model
    const hits = await this.kb.search(text);
    const entries = hits.map((h, i) => ({ n: i + 1, title: h.title, text: h.text }));
    const turns: Turn[] = [...(await this.history(cv.id, user.id)), { role: 'user', text: userTurn(entries, text) }];
    const started = Date.now();
    let out;
    try {
      out = await this.llm.generate({ system: conciergeSystem(t.name), turns, thinking: 'low', maxOutputTokens: 600, timeoutMs: 20_000 });
    } catch (e) {
      await this.meter.release(t.id, 'ai.concierge', 1);
      this.log.warn(`${t.slug}: model call failed: ${(e as Error).message}`);
      return reply({ kind: 'FALLBACK', text: say('fallback', language), sources: [], offerHandoff: true, emergency: null, model: this.llm.chatModel, finishReason: 'ERROR', latencyMs: Date.now() - started });
    }
    const meta = { model: out.model, finishReason: out.finishReason, usage: out.usage, latencyMs: Date.now() - started };
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
      offerHandoff: noAnswer, emergency: null, safety: noAnswer ? { noAnswer: true } : null, ...meta,
    });
  }

  /** The last few turns as plain text (answers only; emergencies and refusals are not fed back to the model). */
  private async history(conversationId: string, excludeId: string): Promise<Turn[]> {
    const t = TenantContext.require();
    const { rows } = await this.db.query(`SELECT id, role, content_enc FROM messages WHERE conversation_id = $1 AND id <> $2 AND kind IN ('TEXT','ANSWER') ORDER BY seq DESC LIMIT $3`, [conversationId, excludeId, HISTORY_TURNS]);
    const turns: Turn[] = [];
    for (const r of rows.reverse()) turns.push({ role: r.role === 'user' ? 'user' : 'model', text: (await this.crypto.decrypt(t.id, this.aad(r.id), r.content_enc)) ?? '' });
    // a conversation must start with the user
    while (turns[0]?.role === 'model') turns.shift();
    return turns;
  }

  async messages(conversationId: string): Promise<ChatMessage[]> {
    const t = TenantContext.require();
    const { rows } = await this.db.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY seq', [conversationId]);
    return Promise.all(rows.map(async (m) => ({
      id: m.id, role: m.role, kind: m.kind, text: (await this.crypto.decrypt(t.id, this.aad(m.id), m.content_enc)) ?? '', sources: m.sources,
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
      return { handoff: toHandoff(h), message: { id: saved.id, role: 'assistant', kind: 'HANDOFF', text, sources: [], offerHandoff: false, emergency: null, createdAt: saved.createdAt } };
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
