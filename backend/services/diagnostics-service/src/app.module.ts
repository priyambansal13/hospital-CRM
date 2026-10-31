import { Inject, Injectable, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { BranchChanged, EventTypes, PaymentSucceeded, RefundProcessed, Topics } from '@mc/contracts';
import { ConsumerRegistry, CoreModule, ModuleHooks, PLACEMENTS, retryInBackground } from '@mc/nest-common';
import { EntitlementsClient, EntitlementsModule } from '@mc/entitlements-sdk';
import { type PlacementSource, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { AuditClient, BillingClient, CareAccessClient, MembershipClient, PatientsClient } from './lab/clients.js';
import { LabHoldExpiryJob } from './lab/hold-expiry.job.js';
import { HomeAdminController, HomeDispatchController, MyVisitsController, PublicHomeController } from './lab/home.controller.js';
import { HomeService } from './lab/home.service.js';
import { LabBenchController, LabCatalogAdminController, LabOrdersController, PublicLabController } from './lab/lab.controller.js';
import { LabService } from './lab/lab.service.js';
import { LabResultsController, ResultsAccessController } from './lab/results.controller.js';
import { ResultsService } from './lab/results.service.js';
import { TatJob } from './lab/tat.job.js';
import { CriticalEscalationJob, InternalLabJobsController } from './lab/critical-escalation.job.js';

@Injectable()
class DiagnosticsConsumers implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly registry: ConsumerRegistry,
    private readonly hooks: ModuleHooks,
    private readonly lab: LabService,
    private readonly home: HomeService,
    private readonly db: TenantDbRouter,
    private readonly entitlements: EntitlementsClient,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource,
  ) {}

  onModuleInit() {
    // module switched on for a hospital (its plan now includes it): the template catalog and collection times.
    // Switched off: nothing to undo; lab data stays readable (SDK guard) and the jobs below skip the hospital.
    this.hooks.register('diagnostics', { enable: async (c) => { await this.lab.seedCatalog(c); await this.lab.ensureAllWindows(c); } });
    this.hooks.register('home_collection', { enable: (c) => this.lab.ensureAllWindows(c) });
    const branch = async (c: Queryable, data: unknown) => {
      const b = BranchChanged.parse(data);
      await c.query(`INSERT INTO branches (id, name, timezone, active) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET name = $2, timezone = $3, active = $4, updated_at = now()`, [b.branchId, b.name, b.timezone, b.active]);
      await this.lab.ensureWindows(c, b.branchId);
    };
    this.registry.register({
      group: 'diagnostics.tenant', topics: [Topics.tenant],
      handlers: {
        [EventTypes.branchCreated]: (e, db) => branch(db!, e.data),
        [EventTypes.branchUpdated]: (e, db) => branch(db!, e.data),
      },
    });
    this.registry.register({
      group: 'diagnostics.staff', topics: [Topics.iam],
      handlers: { [EventTypes.staffJoined]: (e, db) => this.home.onStaffJoined(db!, e.data) },
    });
    this.registry.register({
      group: 'diagnostics.payments', topics: [Topics.billing],
      handlers: {
        [EventTypes.paymentSucceeded]: async (e, db) => { const p = PaymentSucceeded.parse(e.data); if (p.sourceType === 'LAB_ORDER') await this.lab.onPaymentSucceeded(db!, p); },
        [EventTypes.refundProcessed]: (e, db) => this.lab.onRefundProcessed(db!, RefundProcessed.parse(e.data)),
      },
    });
  }

  /** Hospitals with diagnostics from before module hooks existed get any newer template tests (and older branches their home times). */
  onApplicationBootstrap() {
    retryInBackground('LabCatalogSeed', async () => {
      for (const t of await this.placements.list()) {
        if (t.status === 'ACTIVE' && (await this.entitlements.moduleState(t.id, 'diagnostics')) === 'ACTIVE') await TenantContext.run(t, () => this.db.tx(async (c) => { await this.lab.seedCatalog(c); await this.lab.ensureAllWindows(c); }));
      }
    });
  }
}

/** Lab: catalog, collection slots, orders, samples (docs/LLD.md §3.5, §6.5); results and reports (Phase 15); home collection (Phase 16). */
@Module({
  imports: [CoreModule.forRoot({ schema: 'diagnostics', control: false, tenant: true, relay: true }), EntitlementsModule],
  controllers: [InternalLabJobsController, PublicLabController, PublicHomeController, HomeAdminController, HomeDispatchController, MyVisitsController, LabOrdersController, LabBenchController, LabCatalogAdminController, LabResultsController, ResultsAccessController],
  providers: [LabService, ResultsService, HomeService, PatientsClient, CareAccessClient, AuditClient, BillingClient, MembershipClient, LabHoldExpiryJob, TatJob, CriticalEscalationJob, DiagnosticsConsumers],
})
export class AppModule {}
