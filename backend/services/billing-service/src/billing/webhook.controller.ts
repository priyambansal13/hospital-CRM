import { Controller, Headers, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import { DomainError, PLACEMENTS, Public } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash } from 'node:crypto';
import { gatewayConfig, verifyWebhookSignature } from '../gateway/gateway.js';
import { BillingService } from './billing.service.js';

/**
 * Razorpay webhooks (payment.captured / payment.failed / refund.processed / refund.failed). No hospital host and no
 * token: authenticity is the HMAC over the raw body; the hospital is found from the order/refund id we recorded.
 * Answers 2xx once handled (or deliberately ignored) so the gateway stops retrying.
 */
@Controller('v1/webhooks')
export class WebhookController {
  private readonly log = new Logger('Webhook');
  constructor(private readonly billing: BillingService, private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post('razorpay')
  @Public()
  @HttpCode(200)
  async razorpay(@Req() req: any, @Headers('x-razorpay-signature') signature: string | undefined, @Headers('x-razorpay-event-id') eventIdHeader: string | undefined) {
    const raw: Buffer | undefined = req.rawBody;
    if (!raw || !signature || !verifyWebhookSignature(raw, signature, gatewayConfig().webhookSecret)) throw new DomainError(401, 'INVALID_SIGNATURE', 'webhook signature does not match');
    const body = JSON.parse(raw.toString('utf8'));
    const eventId = eventIdHeader ?? `sha:${createHash('sha256').update(raw).digest('hex')}`;
    const tenantId = await this.billing.tenantForWebhook(body.payload);
    if (!tenantId) {
      this.log.warn(`${body.event} ${eventId}: no hospital for this order/refund, ignored`);
      return { status: 'ignored' };
    }
    const tenant = await this.placements.get(tenantId);
    const result = await TenantContext.run(tenant, () => this.db.tx((c) => this.billing.onWebhook(c, eventId, body.event, body.payload)));
    return { status: result };
  }
}
