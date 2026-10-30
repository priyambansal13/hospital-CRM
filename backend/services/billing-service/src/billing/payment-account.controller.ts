import { Body, Controller, Get, Put } from '@nestjs/common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { AdminAudited, CurrentActor, parse, TenantPublic } from '@mc/nest-common';
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
  @AdminAudited('PAYOUT_ACCOUNT')
  @RequirePermission('settings:manage:tenant')
  connect(@Body() body: unknown, @CurrentActor() a: Actor) {
    return this.accounts.connect(a.email ?? a.id, parse(Connect, body));
  }

  /** For booking pages (signed out too): can patients pay online here? */
  @Get('public/payment-status')
  @TenantPublic()
  async status() {
    return { online: await this.accounts.onlineReady() };
  }
}
