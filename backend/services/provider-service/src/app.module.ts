import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { BranchChanged, EventTypes, Topics } from '@mc/contracts';
import { ConsumerRegistry, CoreModule } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import type { Queryable } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { DirectoryRepo } from './directory/directory.repo.js';
import { DoctorsController } from './directory/doctors.controller.js';
import { IamClient } from './directory/iam.client.js';
import { InternalProviderController } from './directory/internal.controller.js';
import { PublicDirectoryController } from './directory/public.controller.js';
import { SpecialtiesController } from './directory/specialties.controller.js';
import { DEFAULT_SPECIALTIES } from './seed/specialties.js';

async function seedSpecialties(c: Queryable) {
  let order = 10;
  for (const s of DEFAULT_SPECIALTIES) {
    await c.query('INSERT INTO specialties (id, code, name, description, sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING', [randomUUID(), s.code, s.name, s.description, order]);
    order += 10;
  }
}

async function upsertBranch(c: Queryable, data: unknown) {
  const b = BranchChanged.parse(data);
  await c.query(`INSERT INTO branches (id, name, active) VALUES ($1,$2,$3)
    ON CONFLICT (id) DO UPDATE SET name = $2, active = $3, updated_at = now()`, [b.branchId, b.name, b.active]);
}

/** tenant.events → default specialties for new hospitals, and the local branches read model. */
@Injectable()
class ProviderConsumers implements OnModuleInit {
  constructor(private readonly registry: ConsumerRegistry) {}
  onModuleInit() {
    this.registry.register({
      group: 'provider.tenant-sync',
      topics: [Topics.tenant],
      handlers: {
        [EventTypes.tenantProvisioned]: (_e, db) => seedSpecialties(db!),
        [EventTypes.branchCreated]: (e, db) => upsertBranch(db!, e.data),
        [EventTypes.branchUpdated]: (e, db) => upsertBranch(db!, e.data),
      },
    });
  }
}

@Module({
  imports: [CoreModule.forRoot({ schema: 'provider', control: false, tenant: true, relay: true }), EntitlementsModule],
  controllers: [DoctorsController, SpecialtiesController, PublicDirectoryController, InternalProviderController],
  providers: [DirectoryRepo, IamClient, ProviderConsumers, DoctorsController],
})
export class AppModule {}
