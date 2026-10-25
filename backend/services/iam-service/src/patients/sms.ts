import { smtpOptions } from '@mc/nest-common';
import { Injectable, Logger } from '@nestjs/common';
import { UsageMeter } from '@mc/entitlements-sdk';
import nodemailer from 'nodemailer';

/**
 * SMS port. Local dev delivers "SMS" to Mailpit (http://localhost:61825) so OTPs can be read by people and tests.
 * Production: an Indian SMS provider with DLT-registered templates per hospital (docs/MULTI-TENANCY.md §7).
 */
@Injectable()
export class SmsSender {
  private readonly log = new Logger('Sms');
  private readonly mail = nodemailer.createTransport(smtpOptions());

  constructor(private readonly meter: UsageMeter) {}

  /**
   * Login codes count towards the hospital's SMS allowance (core.sms) but are never refused: signing in must always
   * work. If metering is unavailable the code still goes out.
   */
  async send(to: string, text: string, tenant: { id: string; slug: string }) {
    const counted = await this.meter.reserve(tenant.id, 'core.sms', 1, { force: true }).then(() => true).catch((e) => { this.log.warn(`sms not metered: ${(e as Error).message}`); return false; });
    try {
      await this.mail.sendMail({ from: `${tenant.slug}@sms.medicare.local`, to: `${to.replace('+', '')}@sms.medicare.local`, subject: `SMS to ${to}`, text });
    } catch (e) {
      if (counted) await this.meter.release(tenant.id, 'core.sms').catch(() => undefined);
      throw e;
    }
    this.log.log(`sms queued to ${to.slice(0, -4)}****`);
  }
}
