import { type SmsProvider, smsProviderFromEnv, type SmsTemplateRef, smtpOptions } from '@mc/nest-common';
import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';

export interface OutgoingMessage { to: string; subject?: string; body: string; fromName: string; tenantSlug: string; template?: SmsTemplateRef | null }
export interface DeliveryResult { providerMessageId: string }

/** Strategy per channel (docs/LLD.md §8): swap providers without touching the planner or dispatcher. */
export interface NotificationChannel {
  readonly name: 'SMS' | 'EMAIL';
  send(m: OutgoingMessage): Promise<DeliveryResult>;
}

const smtp = () => nodemailer.createTransport(smtpOptions());

/** Email over SMTP (Mailpit locally; SES/SendGrid SMTP in staging/production). */
@Injectable()
export class EmailChannel implements NotificationChannel {
  readonly name = 'EMAIL' as const;
  private readonly mail = smtp();
  async send(m: OutgoingMessage) {
    const from = process.env.EMAIL_FROM ?? `${m.tenantSlug}@notify.medicare.local`;
    const info = await this.mail.sendMail({ from: `"${m.fromName}" <${from}>`, to: m.to, subject: m.subject ?? m.fromName, text: m.body });
    return { providerMessageId: info.messageId };
  }
}

/**
 * SMS through the shared provider (review A-2): Mailpit locally (rendered text), MSG91 with DLT-registered templates
 * when SMS_PROVIDER=msg91 (the message's template id and variables; a message without a registered template is not sent).
 */
@Injectable()
export class SmsChannel implements NotificationChannel {
  readonly name = 'SMS' as const;
  private provider?: SmsProvider;
  async send(m: OutgoingMessage) {
    this.provider ??= smsProviderFromEnv();
    return this.provider.send({ to: m.to, text: m.body, tenantSlug: m.tenantSlug, template: m.template ?? null });
  }
}
