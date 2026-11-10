import { Module } from '@nestjs/common';
import { CONTROL_DB, CoreModule, PLACEMENTS } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import type pg from 'pg';
import { BranchesController, InternalBranchCountController, PublicBranchesController } from './branches/branches.controller.js';
import { BrandingController, InternalCatalogController } from './catalog/catalog.controller.js';
import { CatalogRepo } from './catalog/catalog.repo.js';
import { DomainsController, SetupController } from './catalog/domains.controller.js';
import { ProvisioningService } from './catalog/provisioning.service.js';
import { GrowthConsoleController, InternalGrowthController, LeadsController } from './growth/growth.controller.js';
import { GrowthJob } from './growth/growth.job.js';
import { GrowthService } from './growth/growth.service.js';
import { BackupMetrics } from './servers/backup-metrics.js';
import { StatusConsoleController, StatusController } from './status/status.controller.js';
import { StatusService } from './status/status.service.js';
import { InternalServersController } from './servers/servers.controller.js';
import { ServersService } from './servers/servers.service.js';
import { SignupController } from './signup/signup.controller.js';
import { SignupSweepJob } from './signup/signup-sweep.job.js';
import { SignupService } from './signup/signup.service.js';

@Module({
  imports: [
    CoreModule.forRoot({
      schema: 'tenant',
      control: true,
      tenant: true,
      relay: true,
      // tenant-service is the source of placements: read the catalog directly instead of calling itself
      placements: { provide: PLACEMENTS, useFactory: (db: pg.Pool) => new CatalogRepo(db), inject: [CONTROL_DB] },
    }),
    EntitlementsModule,
  ],
  controllers: [InternalCatalogController, BrandingController, BranchesController, PublicBranchesController, InternalBranchCountController, SignupController, DomainsController, SetupController, InternalServersController, LeadsController, GrowthConsoleController, InternalGrowthController, StatusController, StatusConsoleController],
  providers: [CatalogRepo, ServersService, ProvisioningService, SignupService, SignupSweepJob, GrowthService, GrowthJob, BackupMetrics, StatusService],
})
export class AppModule {}
