import { Module } from '@nestjs/common';
import { CoreModule } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { InternalPlansController, PlanController, SubscriptionConsumers } from './plans.controller.js';
import { PlansService } from './plans.service.js';
import { BuilderService } from './builder.service.js';
import { ConsoleController } from './console.controller.js';
import { AccountController, InternalBillingController } from './billing/billing.controller.js';
import { BillingService } from './billing/billing.service.js';
import { RECURRING_GATEWAY, SimulatedCards } from './billing/gateway.js';
import { UsageService } from './billing/usage.service.js';

/** Editions, plans and plan versions, add-ons, contracts per hospital, the platform console API, SaaS billing and usage (docs/PRODUCT-MODULES-AND-PLANS.md). Control plane only. */
@Module({
  imports: [CoreModule.forRoot({ schema: 'subscription', control: true, tenant: false, relay: true }), EntitlementsModule],
  controllers: [PlanController, InternalPlansController, ConsoleController, AccountController, InternalBillingController],
  providers: [
    PlansService, BuilderService, BillingService, UsageService, SubscriptionConsumers,
    // hospitals' recurring payments: the simulator in dev (a real Razorpay recurring adapter is not built yet)
    { provide: RECURRING_GATEWAY, useFactory: () => new SimulatedCards() },
  ],
})
export class AppModule {}
