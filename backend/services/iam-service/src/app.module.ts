import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { StepUpController } from './stepup/step-up.js';
import { EventTypes, TenantProvisioned, Topics } from '@mc/contracts';
import { ConsumerRegistry, CoreModule, PLACEMENTS, retryInBackground } from '@mc/nest-common';
import type { PlacementSource } from '@mc/tenancy';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { KeycloakAdmin } from './keycloak/keycloak-admin.js';
import { InternalPersonsController } from './patients/internal-persons.controller.js';
import { PatientAuthController } from './patients/patient-auth.controller.js';
import { SmsSender } from './patients/sms.js';
import { TokenService } from './patients/token.service.js';
import { InternalStaffController } from './staff/internal-staff.controller.js';
import { StaffController } from './staff/staff.controller.js';
import { StaffService } from './staff/staff.service.js';

/** tenant.provisioned → Keycloak organization + first hospital admin (in the hospital's own database). */
@Injectable()
class IamConsumers implements OnModuleInit {
  constructor(private readonly registry: ConsumerRegistry, private readonly staff: StaffService) {}
  onModuleInit() {
    this.registry.register({
      group: 'iam.tenant-provisioning',
      topics: [Topics.tenant],
      handlers: { [EventTypes.tenantProvisioned]: (evt, db) => this.staff.onTenantProvisioned(TenantProvisioned.parse(evt.data), db!) },
    });
  }
}

/**
 * Keycloak hygiene: tokens without the per-hospital origins list, and login redirects only for hospitals that exist
 * (on start and every 30 minutes; deleted hospitals' events are skipped by the consumers, so this is a sweep).
 */
@Injectable()
class WebHostSweep implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('WebHosts');
  private timer?: NodeJS.Timeout;
  constructor(private readonly kc: KeycloakAdmin, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    retryInBackground('WebHosts', () => this.run());
    this.timer = setInterval(() => void this.run().catch((e) => this.log.warn((e as Error).message)), 30 * 60_000);
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async run() {
    await this.kc.slimWebTokens();
    const tpl = process.env.PUBLIC_WEB_URL ?? `http://{host}:${process.env.WEB_PORT ?? '3400'}`;
    const live = (await this.placements.list()).filter((t) => t.status !== 'DELETED').flatMap((t) => t.hosts.map((h) => tpl.replace('{host}', h)));
    await this.kc.reconcileWebHosts(new Set(live));
  }
}

@Module({
  imports: [CoreModule.forRoot({ schema: 'iam', control: true, tenant: true, relay: true }), EntitlementsModule],
  controllers: [StepUpController, PatientAuthController, StaffController, InternalStaffController, InternalPersonsController],
  providers: [
    KeycloakAdmin, StaffService, TokenService, SmsSender,
    IamConsumers, WebHostSweep,
  ],
})
export class AppModule {}
