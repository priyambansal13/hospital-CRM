import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { ContractChanged, EventTypes, StaffJoined, SubscriptionStatusChanged, Topics } from '@mc/contracts';
import { ConsumerRegistry, CoreModule } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { EntitlementsController, InternalEntitlementsController } from './entitlements.controller.js';
import { ConfigService } from './config.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { ModuleLifecycleJob } from './module-lifecycle.job.js';

@Injectable()
class EntitlementConsumers implements OnModuleInit {
  constructor(private readonly registry: ConsumerRegistry, private readonly svc: EntitlementsService) {}
  onModuleInit() {
    this.registry.register({
      group: 'entitlement.tenant-setup',
      topics: [Topics.tenant],
      handlers: { [EventTypes.tenantProvisioned]: (_evt, db) => this.svc.onTenantProvisioned(db!) },
    });
    this.registry.register({
      group: 'entitlement.staff-roles',
      topics: [Topics.iam],
      handlers: {
        [EventTypes.staffJoined]: async (evt, db) => {
          const d = StaffJoined.parse(evt.data);
          await this.svc.rememberUser(db!, d.userId, d.email);
          await this.svc.assignRoles(db!, d.userId, d.initialRoles);
        },
      },
    });
    this.registry.register({
      group: 'entitlement.contracts',
      topics: [Topics.subscription],
      handlers: {
        [EventTypes.contractChanged]: async (evt, db) => { await this.svc.applyContract(db!, ContractChanged.parse(evt.data)); },
        [EventTypes.subscriptionStatusChanged]: (evt, db) => this.svc.applyBillingStatus(db!, SubscriptionStatusChanged.parse(evt.data)),
      },
    });
  }
}

@Module({
  imports: [CoreModule.forRoot({ schema: 'entitlement', control: true, tenant: true, relay: true }), EntitlementsModule],
  controllers: [EntitlementsController, InternalEntitlementsController],
  providers: [EntitlementsService, ConfigService, EntitlementConsumers, ModuleLifecycleJob],
})
export class AppModule {}
