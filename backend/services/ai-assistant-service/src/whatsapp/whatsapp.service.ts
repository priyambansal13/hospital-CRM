import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TenantPlacement } from '@mc/contracts';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { CONTROL_DB, DomainError, FieldCrypto, PLACEMENTS, REDIS, type Redis } from '@mc/nest-common';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { type ChatMessage, ChatService } from '../chat/chat.service.js';
import { appSecret, type WaButton, whatsAppSenderFromEnv } from './sender.js';

/** Meta's webhook payload, the parts used here. */
interface WaMessage { id: string; from: string; type: string; text?: { body: string }; interactive?: { type: string; button_reply?: { id: string; title: string } } }
interface WaWebhook { entry?: { changes?: { value?: { metadata?: { phone_number_id?: string }; messages?: WaMessage[] } }[] }[] }

const LINK_DAYS = 30;
const T = {
  code: 'To keep your health information private, we have sent a 6-digit login code by SMS to this number. Reply here with the code.',
  wrong: 'That code is not right. Check the SMS and try again, or send "hi" for a new code.',
  linked: 'You are linked. Ask me about doctors, times, your appointments or the hospital. Reports are shown only in the app.',
  limited: 'Too many codes were sent. Please try again in a few minutes.',
  off: 'The hospital\'s assistant is not available on WhatsApp. Please use the app or call the hospital.',
  rejected: 'OK, nothing was changed.',
  busy: 'One moment, I am still working on your last message.',
};

export const signatureOk = (raw: Buffer, header: string | undefined) => {
  const secret = appSecret();
  if (!secret || !header?.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
};

/**
 * The concierge on WhatsApp (IMPLEMENTATION-PLAN.md Phase 25, docs/AI-AGENTS.md §4.5). A phone is linked to the
 * patient once per 30 days with the hospital's normal SMS login code (iam's own OTP flow), which opens an ordinary
 * patient session; its refresh token is kept encrypted and rotated on every message, so the chat and every tool run
 * with the patient's own token. Confirm cards become reply buttons. No report contents are sent here.
 */
@Injectable()
export class WhatsAppService {
  private readonly log = new Logger('WhatsApp');
  private readonly sender = whatsAppSenderFromEnv();

  constructor(
    @Inject(CONTROL_DB) private readonly control: pg.Pool, private readonly db: TenantDbRouter, private readonly crypto: FieldCrypto, private readonly chat: ChatService,
    private readonly entitlements: EntitlementsClient, @Inject(PLACEMENTS) private readonly placements: PlacementSource, @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** MediCare links a hospital's WhatsApp Business number (internal: console / `mc whatsapp link`). */
  async linkNumber(tenantId: string, phoneNumberId: string, displayNumber: string) {
    await this.control.query(`INSERT INTO whatsapp_numbers (phone_number_id, tenant_id, display_number) VALUES ($1,$2,$3)
      ON CONFLICT (phone_number_id) DO UPDATE SET tenant_id = $2, display_number = $3, active = true`, [phoneNumberId, tenantId, displayNumber]);
    return { phoneNumberId, tenantId, displayNumber };
  }

  async numbers(tenantId: string) {
    return (await this.control.query('SELECT phone_number_id, display_number, active FROM whatsapp_numbers WHERE tenant_id = $1', [tenantId])).rows
      .map((r) => ({ phoneNumberId: r.phone_number_id, displayNumber: r.display_number, active: r.active }));
  }

  /** The webhook's body (signature already checked): each new message, in its hospital, in the background. */
  async receive(body: WaWebhook) {
    for (const change of (body.entry ?? []).flatMap((e) => e.changes ?? [])) {
      const pnid = change.value?.metadata?.phone_number_id;
      const messages = change.value?.messages ?? [];
      if (!pnid || !messages.length) continue;
      const { rows: [n] } = await this.control.query('SELECT tenant_id FROM whatsapp_numbers WHERE phone_number_id = $1 AND active', [pnid]);
      if (!n) { this.log.warn(`message for an unknown number ${pnid}: ignored`); continue; }
      const tenant = await this.placements.get(n.tenant_id);
      for (const m of messages) {
        // Meta retries: each message once
        if ((await this.redis.set(`wa:msg:${m.id}`, '1', 'EX', 86_400, 'NX')) !== 'OK') continue;
        void TenantContext.run(tenant, () => this.onMessage(tenant, pnid, m)).catch((e) => this.log.warn(`${tenant.slug}: message ${m.id}: ${(e as Error).message}`));
      }
    }
  }

  private reply(pnid: string, to: string, text: string, buttons?: WaButton[]) {
    return this.sender.send(pnid, to, text, buttons);
  }

  /** One message at a time per phone (the session's refresh token rotates on every use). */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    for (let i = 0; i < 40; i++) {
      if ((await this.redis.set(key, '1', 'EX', 60, 'NX')) === 'OK') {
        try { return await fn(); } finally { await this.redis.del(key); }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  private async onMessage(t: TenantPlacement, pnid: string, m: WaMessage) {
    const phone = `+${m.from.replace(/\D/g, '')}`;
    const to = m.from.replace(/\D/g, '');
    if (!(await this.entitlements.tenantFeatures(t.id)).features['ai.whatsapp']?.enabled) return this.reply(pnid, to, T.off);
    const done = await this.withLock(`wa:lock:${t.id}:${phone}`, async () => {
      const actor = await this.session(t, pnid, phone, to, m);
      if (!actor) return;
      const button = m.type === 'interactive' ? m.interactive?.button_reply?.id ?? '' : '';
      if (button) return this.onButton(t, pnid, to, phone, actor, button);
      const text = m.type === 'text' ? m.text?.body?.trim() ?? '' : '';
      if (!text) return this.reply(pnid, to, 'I can read text messages only.');
      return this.onText(t, pnid, to, phone, actor, text);
    });
    if (done === null) await this.reply(pnid, to, T.busy);
  }

  private iam(t: TenantPlacement, path: string, body: unknown, phone: string) {
    return fetch(`${process.env.SVC_URL_IAM ?? 'http://localhost:4402'}${path}`, {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      // iam's per-address limits count WhatsApp users per phone (they all arrive from this service)
      headers: { 'content-type': 'application/json', 'x-tenant-host': t.hosts[0], 'x-real-ip': `whatsapp:${phone}` },
    });
  }

  /** The patient behind this phone, with a fresh token; or the login-code exchange, when the phone is not linked. */
  private async session(t: TenantPlacement, pnid: string, phone: string, to: string, m: WaMessage): Promise<Actor | null> {
    const { rows: [link] } = await this.db.query('SELECT * FROM wa_links WHERE phone = $1', [phone]);
    const text = m.type === 'text' ? m.text?.body?.trim() ?? '' : '';
    if (link?.state === 'LINKED' && new Date(link.verified_until).getTime() > Date.now()) {
      const refresh = await this.crypto.decrypt(t.id, `wa_links.refresh:${phone}`, link.refresh_enc);
      const r = await this.iam(t, '/v1/auth/refresh', { refreshToken: refresh }, phone);
      if (r.ok) {
        const s = (await r.json()) as { accessToken: string; refreshToken: string };
        await this.db.query('UPDATE wa_links SET refresh_enc = $2, updated_at = now() WHERE phone = $1', [phone, await this.crypto.encrypt(t.id, `wa_links.refresh:${phone}`, s.refreshToken)]);
        return { id: link.person_id, kind: 'patient', token: s.accessToken };
      }
      this.log.warn(`${t.slug}: WhatsApp session for a phone ended (${r.status}); asking for a new code`);
    }
    // a code sent earlier: the reply is the code
    if (link?.state === 'CODE_SENT' && /^\d{6}$/.test(text)) {
      const r = await this.iam(t, '/v1/auth/otp/verify', { phone, code: text }, phone);
      if (!r.ok) { await this.reply(pnid, to, T.wrong); return null; }
      const s = (await r.json()) as { accessToken: string; refreshToken: string };
      const personId = JSON.parse(Buffer.from(s.accessToken.split('.')[1], 'base64url').toString()).sub as string;
      await this.db.query(`UPDATE wa_links SET state = 'LINKED', person_id = $2, refresh_enc = $3, verified_until = now() + make_interval(days => $4), updated_at = now() WHERE phone = $1`,
        [phone, personId, await this.crypto.encrypt(t.id, `wa_links.refresh:${phone}`, s.refreshToken), LINK_DAYS]);
      await this.reply(pnid, to, T.linked);
      return null;
    }
    // otherwise: (re)send the hospital's login code by SMS
    const r = await this.iam(t, '/v1/auth/otp/request', { phone }, phone);
    if (r.status === 429) { await this.reply(pnid, to, T.limited); return null; }
    if (!r.ok) throw new DomainError(502, 'IAM', `code request ${r.status}`);
    await this.db.query(`INSERT INTO wa_links (phone, state, code_sent_at) VALUES ($1, 'CODE_SENT', now())
      ON CONFLICT (phone) DO UPDATE SET state = 'CODE_SENT', code_sent_at = now(), refresh_enc = NULL, updated_at = now()`, [phone]);
    await this.reply(pnid, to, T.code);
    return null;
  }

  private async onText(t: TenantPlacement, pnid: string, to: string, phone: string, actor: Actor, text: string) {
    const { rows: [link] } = await this.db.query('SELECT conversation_id FROM wa_links WHERE phone = $1', [phone]);
    const send = (conversationId?: string) => this.chat.send(actor, { text, ...(conversationId ? { conversationId } : {}) }, 'WHATSAPP');
    const r = await send(link?.conversation_id ?? undefined).catch((e) => {
      // the last chat was closed or handed to a person: start a new one
      if (e instanceof DomainError && ['CONVERSATION_CLOSED', 'NOT_FOUND'].includes(e.code)) return send();
      throw e;
    });
    await this.db.query('UPDATE wa_links SET conversation_id = $2 WHERE phone = $1', [phone, r.conversationId]);
    await this.sendMessage(pnid, to, r.message);
  }

  /** A chat message as WhatsApp messages: the text (with "Talk to a person" when offered), then one per Confirm card. */
  private async sendMessage(pnid: string, to: string, m: ChatMessage) {
    await this.reply(pnid, to, m.text, m.offerHandoff ? [{ id: 'handoff', title: 'Talk to a person' }] : undefined);
    for (const c of m.cards.filter((x) => x.status === 'PENDING')) {
      await this.reply(pnid, to, `${c.title}\n${c.lines.filter(Boolean).join('\n')}`, [{ id: `confirm:${c.id}`, title: c.confirmLabel.slice(0, 20) }, { id: `reject:${c.id}`, title: 'Not now' }]);
    }
  }

  private async onButton(t: TenantPlacement, pnid: string, to: string, phone: string, actor: Actor, id: string) {
    const [kind, actionId] = id.split(':');
    if (kind === 'confirm' && actionId) {
      const r = await this.chat.confirm(actor, actionId).catch((e: DomainError) => ({ error: e.message }));
      if ('error' in r) return this.reply(pnid, to, `That did not go through: ${r.error}`);
      return r.message ? this.sendMessage(pnid, to, r.message) : this.reply(pnid, to, 'Already done.');
    }
    if (kind === 'reject' && actionId) {
      await this.chat.reject(actor, actionId).catch(() => null);
      return this.reply(pnid, to, T.rejected);
    }
    if (kind === 'handoff') {
      const { rows: [link] } = await this.db.query('SELECT conversation_id FROM wa_links WHERE phone = $1', [phone]);
      if (!link?.conversation_id) return this.reply(pnid, to, 'Send us your question first, then you can ask for a person.');
      const r = await this.chat.handoff(actor, link.conversation_id, { reason: 'ASKED', phone });
      return this.reply(pnid, to, r.message?.text ?? 'The hospital will call you back.');
    }
    this.log.warn(`${t.slug}: unknown WhatsApp button ${id}`);
  }
}
