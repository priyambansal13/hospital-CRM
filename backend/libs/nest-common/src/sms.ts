import nodemailer from 'nodemailer';
import { smtpOptions } from './smtp.js';

/**
 * SMS provider (review A-2). India requires every business SMS to use a template registered on the DLT platform
 * (with the sender id and the principal entity), so a real send names a registered template and fills its variables;
 * free text is refused by the operators.
 *  - mailpit (default locally): delivered to Mailpit as <number>@sms.medicare.local, rendered text.
 *  - msg91: MSG91 Flow API (template id + variables). MSG91_AUTH_KEY; MSG91_BASE_URL for tests.
 * Chosen by SMS_PROVIDER. Built against MSG91's documented API and tested against a fake; not yet run with a live account.
 */
export interface SmsTemplateRef {
  /** the provider's id of the DLT-registered template (MSG91 flow/template id) */
  providerTemplateId: string;
  /** values for the template's variables, by the names it was registered with */
  vars: Record<string, string>;
}
export interface SmsRequest { to: string; text: string; tenantSlug: string; template?: SmsTemplateRef | null }
export interface SmsProvider { readonly name: 'mailpit' | 'msg91'; send(r: SmsRequest): Promise<{ providerMessageId: string }> }

export class MailpitSms implements SmsProvider {
  readonly name = 'mailpit' as const;
  private readonly mail = nodemailer.createTransport(smtpOptions());
  async send(r: SmsRequest) {
    const info = await this.mail.sendMail({ from: `${r.tenantSlug}@sms.medicare.local`, to: `${r.to.replace('+', '')}@sms.medicare.local`, subject: `SMS to ${r.to}`, text: r.text });
    return { providerMessageId: info.messageId };
  }
}

export class SmsNotRegistered extends Error {
  constructor() { super('no DLT-registered SMS template for this message: register it and add its template id'); }
}

export class Msg91Sms implements SmsProvider {
  readonly name = 'msg91' as const;
  constructor(private readonly authKey = process.env.MSG91_AUTH_KEY ?? '', private readonly base = process.env.MSG91_BASE_URL ?? 'https://control.msg91.com', private readonly fetchFn: typeof fetch = fetch) {
    if (!authKey) throw new Error('SMS_PROVIDER=msg91 needs MSG91_AUTH_KEY');
  }
  async send(r: SmsRequest) {
    if (!r.template) throw new SmsNotRegistered();
    const mobile = r.to.replace(/^\+/, '');
    if (!/^91\d{10}$/.test(mobile)) throw new Error('MSG91: Indian mobile numbers only (+91…)');
    const res = await this.fetchFn(`${this.base}/api/v5/flow/`, {
      method: 'POST', headers: { authkey: this.authKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ template_id: r.template.providerTemplateId, short_url: '0', recipients: [{ mobiles: mobile, ...r.template.vars }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!res.ok || body.type !== 'success') throw new Error(`MSG91 ${res.status}: ${body.message ?? 'send failed'}`);
    return { providerMessageId: String(body.message ?? '') };
  }
}

export function smsProviderFromEnv(): SmsProvider {
  const p = process.env.SMS_PROVIDER ?? 'mailpit';
  if (p === 'mailpit') return new MailpitSms();
  if (p === 'msg91') return new Msg91Sms();
  throw new Error(`SMS_PROVIDER must be mailpit or msg91 (got "${p}")`);
}
