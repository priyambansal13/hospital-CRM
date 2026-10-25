import { Module } from '@nestjs/common';
import { CONTROL_DB, CoreModule, PLACEMENTS } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import type pg from 'pg';
import { BranchesController, InternalBranchCountController } from './branches/branches.controller.js';
import { BrandingController, InternalCatalogController } from './catalog/catalog.controller.js';
import { CatalogRepo } from './catalog/catalog.repo.js';
import { DomainsController, SetupController } from './catalog/domains.controller.js';
import { ProvisioningService } from './catalog/provisioning.service.js';
import { SignupController } from './signup/signup.controller.js';
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
  controllers: [InternalCatalogController, BrandingController, BranchesController, InternalBranchCountController, SignupController, DomainsController, SetupController],
  providers: [CatalogRepo, ProvisioningService, SignupService],
})
export class AppModule {}
