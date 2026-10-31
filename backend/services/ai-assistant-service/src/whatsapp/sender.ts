import { isDev, smtpOptions } from '@mc/nest-common';
import nodemailer from 'nodemailer';

/** One reply button (WhatsApp allows 3 per message, titles up to 20 characters). */
export interface WaButton { id: string; title: string }

export interface WhatsAppSender {
  readonly name: 'meta' | 'sim';
  send(phoneNumberId: string, to: string, text: string, buttons?: WaButton[]): Promise<void>;
}

/** WhatsApp Cloud API (Meta). Needs WHATSAPP_ACCESS_TOKEN (a system user token of MediCare's business account). */
class MetaSender implements WhatsAppSender {
  readonly name = 'meta' as const;
  async send(phoneNumberId: string, to: string, text: string, buttons: WaButton[] = []) {
    const body = buttons.length
      ? { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: text.slice(0, 1024) }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) } } }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4096) } };
    const res = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? 'v21.0'}/${phoneNumberId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN ?? ''}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Development: messages land in Mailpit as <number>@whatsapp.medicare.local, with the button ids, like SMS do. */
class SimSender implements WhatsAppSender {
  readonly name = 'sim' as const;
  private readonly mail = nodemailer.createTransport(smtpOptions());
  async send(phoneNumberId: string, to: string, text: string, buttons: WaButton[] = []) {
    await this.mail.sendMail({
      from: `WhatsApp ${phoneNumberId} <whatsapp@medicare.local>`, to: `${to.replace(/\D/g, '')}@whatsapp.medicare.local`, subject: `WhatsApp: ${text.split('\n')[0].slice(0, 60)}`,
      text: `${text}${buttons.length ? `\n\n${buttons.map((b) => `[${b.title}] (${b.id})`).join('\n')}` : ''}`,
    });
  }
}

export function whatsAppSenderFromEnv(): WhatsAppSender {
  const p = process.env.WHATSAPP_PROVIDER ?? (isDev() ? 'sim' : 'meta');
  if (p === 'sim' && !isDev()) throw new Error('WHATSAPP_PROVIDER=sim is for local development only');
  return p === 'sim' ? new SimSender() : new MetaSender();
}

/** The app secret that signs Meta's webhook calls; a fixed one in development. */
export const appSecret = () => process.env.WHATSAPP_APP_SECRET ?? (isDev() ? 'dev-whatsapp-app-secret' : '');
export const verifyToken = () => process.env.WHATSAPP_VERIFY_TOKEN ?? (isDev() ? 'dev-whatsapp-verify' : '');
