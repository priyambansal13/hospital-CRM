import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { AppointmentChanged, EventTypes, LabOrderChanged, PaymentUnapplied, TenantProvisioned, Topics } from '@mc/contracts';
import { ConsumerRegistry, CoreModule, isDev, REDIS, type Redis } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { BillingController } from './billing/billing.controller.js';
import { BillingService } from './billing/billing.service.js';
import { InternalInvoicesController } from './billing/internal.controller.js';
import { PaymentAccountController } from './billing/payment-account.controller.js';
import { PaymentAccountService } from './billing/payment-account.service.js';
import { RefundJob } from './billing/refund.job.js';
import { WebhookController } from './billing/webhook.controller.js';
import { gatewayConfig, PAYMENT_GATEWAY, type PaymentGateway } from './gateway/gateway.js';
import { RazorpayGateway } from './gateway/razorpay.js';
import { SimulatedRazorpay } from './gateway/simulator.js';

/** PAYMENT_GATEWAY=razorpay uses Razorpay (test or live keys); "simulated" (local default) is refused outside dev. */
function gatewayFactory(redis: Redis): PaymentGateway {
  const mode = process.env.PAYMENT_GATEWAY ?? (isDev() ? 'simulated' : 'razorpay');
  if (mode === 'razorpay') return new RazorpayGateway(gatewayConfig());
  if (mode === 'simulated' && isDev()) return new SimulatedRazorpay(gatewayConfig(), redis);
  throw new Error(`PAYMENT_GATEWAY=${mode} is not allowed here (simulated works only in dev)`);
}

/** The booking ↔ payment saga, billing side (docs/LLD.md §5.3–5.5). */
@Injectable()
class BillingConsumers implements OnModuleInit {
  constructor(private readonly registry: ConsumerRegistry, private readonly billing: BillingService, private readonly accounts: PaymentAccountService) {}
  onModuleInit() {
    this.registry.register({
      group: 'billing.tenant-setup',
      topics: [Topics.tenant],
      handlers: { [EventTypes.tenantProvisioned]: (e, db) => { const t = TenantProvisioned.parse(e.data); return this.accounts.onProvisioned(db!, t.source, t.slug); } },
    });
    const appt = (fn: (c: any, a: AppointmentChanged) => Promise<unknown>) => (e: any, db: any) => fn(db!, AppointmentChanged.parse(e.data)).then(() => undefined);
    this.registry.register({
      group: 'billing.appointments',
      topics: [Topics.scheduling],
      handlers: {
        [EventTypes.appointmentBooked]: appt((c, a) => this.billing.onAppointmentBooked(c, a)),
        [EventTypes.appointmentRescheduled]: appt((c, a) => this.billing.onAppointmentRescheduled(c, a)),
        [EventTypes.appointmentCancelled]: appt((c, a) => this.billing.onAppointmentCancelled(c, a)),
        [EventTypes.appointmentExpired]: appt((c, a) => this.billing.onAppointmentExpired(c, a)),
        [EventTypes.paymentUnapplied]: (e, db) => this.billing.onPaymentUnapplied(db!, PaymentUnapplied.parse(e.data)),
      },
    });
    const lab = (fn: (c: any, o: LabOrderChanged) => Promise<unknown>) => (e: any, db: any) => fn(db!, LabOrderChanged.parse(e.data)).then(() => undefined);
    this.registry.register({
      group: 'billing.lab-orders',
      topics: [Topics.diagnostics],
      handlers: {
        [EventTypes.labOrderBooked]: lab((c, o) => this.billing.onLabOrderBooked(c, o)),
        [EventTypes.labOrderCancelled]: lab((c, o) => this.billing.onSourceCancelled(c, 'LAB_ORDER', o.orderId, o.refundPercent ?? null, 'Lab tests cancelled')),
        [EventTypes.labOrderExpired]: lab((c, o) => this.billing.onSourceExpired(c, 'LAB_ORDER', o.orderId)),
        [EventTypes.labPaymentUnapplied]: (e, db) => this.billing.onPaymentUnapplied(db!, PaymentUnapplied.parse(e.data)),
      },
    });
  }
}

@Module({
  imports: [CoreModule.forRoot({ schema: 'billing', control: true, tenant: true, relay: true }), EntitlementsModule],
  controllers: [BillingController, WebhookController, InternalInvoicesController, PaymentAccountController],
  providers: [
    { provide: PAYMENT_GATEWAY, useFactory: gatewayFactory, inject: [REDIS] },
    BillingService, PaymentAccountService, RefundJob, BillingConsumers,
  ],
})
export class AppModule {}
