import { Module } from '@nestjs/common';
import { CoreModule } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { QueueHub } from './hub.js';
import { RealtimeController } from './realtime.controller.js';

/** Realtime gateway: Kafka → server-sent events for live screens. No database. */
@Module({
  imports: [CoreModule.forRoot({ schema: 'realtime', control: false, tenant: false, relay: false }), EntitlementsModule],
  controllers: [RealtimeController],
  providers: [QueueHub],
})
export class AppModule {}
