import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { DomainError, Internal, notFound, parse, Public } from '@mc/nest-common';
import { z } from 'zod';
import { verifyToken } from './sender.js';
import { signatureOk, WhatsAppService } from './whatsapp.service.js';

const Link = z.object({ phoneNumberId: z.string().regex(/^\d{6,20}$/), displayNumber: z.string().trim().regex(/^\+?[0-9 ]{8,20}$/) });

/** Meta's WhatsApp webhook (one URL for every hospital's number). Answers at once; messages are handled in the background. */
@Controller('v1/public/whatsapp')
export class WhatsAppWebhookController {
  constructor(private readonly wa: WhatsAppService) {}

  /** Meta's subscription check: echo the challenge when the verify token matches. */
  @Get('webhook')
  @Public()
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res({ passthrough: true }) reply: any) {
    if (mode !== 'subscribe' || !token || token !== verifyToken()) throw new DomainError(403, 'VERIFY_TOKEN', 'verify token does not match');
    reply.header('content-type', 'text/plain');
    return challenge;
  }

  @Post('webhook')
  @Public()
  @HttpCode(200)
  async receive(@Req() req: any, @Headers('x-hub-signature-256') signature: string | undefined) {
    const raw: Buffer | undefined = req.rawBody;
    if (!raw || !signatureOk(raw, signature)) throw new DomainError(401, 'INVALID_SIGNATURE', 'webhook signature does not match');
    await this.wa.receive(JSON.parse(raw.toString('utf8')));
    return { status: 'ok' };
  }
}

/** MediCare links a hospital's WhatsApp Business number to it (the assistant then answers there). */
@Controller('internal/tenants/:tenantId/whatsapp')
export class InternalWhatsAppController {
  constructor(private readonly wa: WhatsAppService) {}

  @Get()
  @Internal()
  list(@Param('tenantId') t: string) {
    if (!z.uuid().safeParse(t).success) throw notFound('tenant');
    return this.wa.numbers(t);
  }

  @Post()
  @Internal()
  link(@Param('tenantId') t: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(t).success) throw notFound('tenant');
    const v = parse(Link, body);
    return this.wa.linkNumber(t, v.phoneNumberId, v.displayNumber);
  }
}
