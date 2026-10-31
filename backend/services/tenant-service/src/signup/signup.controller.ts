import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { clientIp, parse, Public } from '@mc/nest-common';
import { PhoneNumber } from '@mc/contracts';
import { z } from 'zod';
import { SignupService } from './signup.service.js';

const Start = z.object({
  hospitalName: z.string().trim().min(3).max(120),
  slug: z.string().trim().toLowerCase(),
  adminName: z.string().trim().min(2).max(80),
  adminEmail: z.email().max(160),
  phone: PhoneNumber.nullable().default(null),
  plan: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/),
});
const Token = z.object({ token: z.string().max(80) });

/**
 * Public signup API (MediCare's own site, before any hospital exists: no tenant host, no token). Rate-limited per
 * e-mail and network; nothing is provisioned until the e-mail link is opened.
 */
@Controller('v1/signup')
export class SignupController {
  constructor(private readonly signups: SignupService) {}

  @Get('slug-available')
  @Public()
  available(@Query('slug') slug: string) {
    return this.signups.available(String(slug ?? ''));
  }

  @Post()
  @Public()
  start(@Body() body: unknown, @Req() req: { headers: Record<string, string | undefined>; ip?: string }) {
    return this.signups.start(parse(Start, body), clientIp(req));
  }

  @Post('verify')
  @Public()
  @HttpCode(200)
  verify(@Body() body: unknown) {
    return this.signups.verify(parse(Token, body).token);
  }

  @Get('status')
  @Public()
  status(@Query('token') token: string) {
    return this.signups.status(String(token ?? ''));
  }
}
