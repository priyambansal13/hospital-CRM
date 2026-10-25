import { smtpOptions } from '@mc/nest-common';
import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';

export interface OutgoingMessage { to: string; subject?: string; body: string; fromName: string; tenantSlug: string }
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
 * SMS. Local/dev: delivered to Mailpit as <number>@sms.medicare.local (same as iam's OTPs). Production: an Indian SMS
 * provider with DLT-registered templates per hospital (MSG91 / Twilio); set SMS_PROVIDER. Not wired yet.
 */
@Injectable()
export class SmsChannel implements NotificationChannel {
  readonly name = 'SMS' as const;
  private readonly mail = smtp();
  async send(m: OutgoingMessage) {
    const provider = process.env.SMS_PROVIDER ?? 'mailpit';
    if (provider !== 'mailpit') throw new Error(`SMS provider ${provider} is not configured yet`);
    const info = await this.mail.sendMail({ from: `${m.tenantSlug}@sms.medicare.local`, to: `${m.to.replace('+', '')}@sms.medicare.local`, subject: `SMS to ${m.to}`, text: m.body });
    return { providerMessageId: info.messageId };
  }
}
