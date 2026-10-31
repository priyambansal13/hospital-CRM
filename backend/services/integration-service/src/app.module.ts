import { Module } from '@nestjs/common';
import { CoreModule, FieldCrypto, InternalKeysController } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { FieldsAdminController, FieldsReadController, InternalFieldsController } from './fields/fields.controller.js';
import { FieldsService } from './fields/fields.service.js';
import { RulesController, WorkflowConsumers } from './workflows/rules.controller.js';
import { RulesService } from './workflows/rules.service.js';

@Module({
  imports: [CoreModule.forRoot({ schema: 'integration', control: true, tenant: true, relay: true }), EntitlementsModule],
  controllers: [InternalKeysController, FieldsAdminController, FieldsReadController, InternalFieldsController, RulesController],
  providers: [FieldCrypto, FieldsService, RulesService, WorkflowConsumers],
})
export class AppModule {}
