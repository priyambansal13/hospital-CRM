import { Body, Controller, Get, Put } from '@nestjs/common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { CurrentActor, parse, TenantPublic } from '@mc/nest-common';
import type { Actor } from '@mc/tenancy';
import { z } from 'zod';
import { PaymentAccountService } from './payment-account.service.js';

const Connect = z.object({
  businessName: z.string().trim().min(3).max(120),
  businessType: z.enum(['proprietorship', 'partnership', 'private_limited', 'llp', 'trust', 'society']),
  pan: z.string().trim().toUpperCase(),
  accountNumber: z.string().transform((s) => s.replace(/\s/g, '')),
  ifsc: z.string().trim().toUpperCase(),
  email: z.email(),
  /** replacing an account: the code e-mailed by iam (POST /api/iam/v1/me/step-up) */
  stepUpCode: z.string().trim().regex(/^\d{6}$/, '6 digits').nullable().default(null),
});

/** The hospital's payout account for patients' online payments (owner only: settings:manage:tenant). */
@Controller('v1')
@RequireModule('billing')
export class PaymentAccountController {
  constructor(private readonly accounts: PaymentAccountService) {}

  @Get('payment-account')
  @RequirePermission('settings:manage:tenant')
  view() {
    return this.accounts.view();
  }

  @Put('payment-account')
  @RequirePermission('settings:manage:tenant')
  connect(@Body() body: unknown, @CurrentActor() a: Actor) {
    const { stepUpCode, ...input } = parse(Connect, body);
    return this.accounts.connect(a, input, stepUpCode);
  }

  @Get('payment-account/history')
  @RequirePermission('settings:manage:tenant')
  history() {
    return this.accounts.history();
  }

  /** For booking pages (signed out too): can patients pay online here? */
  @Get('public/payment-status')
  @TenantPublic()
  async status() {
    return { online: await this.accounts.onlineReady() };
  }
}
