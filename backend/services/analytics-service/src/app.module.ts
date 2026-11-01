import { Module } from '@nestjs/common';
import { CoreModule } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { AnalyticsController, InternalAnalyticsController, WarehouseConsumers } from './analytics.controller.js';
import { AnalyticsService } from './semantic/analytics.service.js';
import { BriefFacts } from './semantic/brief.js';
import { Backfill } from './warehouse/backfill.js';
import { WarehouseLoader } from './warehouse/loader.js';

@Module({
  imports: [CoreModule.forRoot({ schema: 'analytics', control: false, tenant: true, relay: false }), EntitlementsModule],
  controllers: [AnalyticsController, InternalAnalyticsController],
  providers: [WarehouseLoader, Backfill, AnalyticsService, BriefFacts, WarehouseConsumers],
})
export class AppModule {}
