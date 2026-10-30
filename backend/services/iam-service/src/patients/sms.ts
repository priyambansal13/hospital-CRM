import { type SmsProvider, smsProviderFromEnv } from '@mc/nest-common';
import { Injectable, Logger } from '@nestjs/common';
import { UsageMeter } from '@mc/entitlements-sdk';

/**
 * Login codes by SMS through the shared provider (review A-2): Mailpit locally (http://localhost:61825, readable by
 * people and tests); MSG91 with MediCare's DLT-registered OTP template (MSG91_OTP_TEMPLATE_ID, variable `code`).
 */
@Injectable()
export class SmsSender {
  private readonly log = new Logger('Sms');
  private provider?: SmsProvider;

  constructor(private readonly meter: UsageMeter) {}

  /**
   * Login codes count towards the hospital's SMS allowance (core.sms) but are never refused: signing in must always
   * work. If metering is unavailable the code still goes out.
   */
  async send(to: string, text: string, tenant: { id: string; slug: string }, code?: string) {
    const counted = await this.meter.reserve(tenant.id, 'core.sms', 1, { force: true }).then(() => true).catch((e) => { this.log.warn(`sms not metered: ${(e as Error).message}`); return false; });
    try {
      this.provider ??= smsProviderFromEnv();
      const tpl = process.env.MSG91_OTP_TEMPLATE_ID;
      await this.provider.send({ to, text, tenantSlug: tenant.slug, template: tpl && code ? { providerTemplateId: tpl, vars: { code, hospital: tenant.slug } } : null });
    } catch (e) {
      if (counted) await this.meter.release(tenant.id, 'core.sms').catch(() => undefined);
      throw e;
    }
    this.log.log(`sms queued to ${to.slice(0, -4)}****`);
  }
}
