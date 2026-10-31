import { Module } from '@nestjs/common';
import { CoreModule, FieldCrypto, InternalKeysController } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { FieldsAdminController, FieldsReadController, InternalFieldsController } from './fields/fields.controller.js';
import { FieldsService } from './fields/fields.service.js';
import { RulesController, WorkflowConsumers } from './workflows/rules.controller.js';
import { IntegrationAudit } from './fhir/audit.js';
import { FhirController } from './fhir/fhir.controller.js';
import { LisService } from './fhir/lis.js';
import { IntegrationConsumers, IntegrationsController, LisResultsController } from './hooks/integrations.controller.js';
import { WebhooksService } from './hooks/webhooks.service.js';
import { ApiKeysService } from './keys/api-keys.service.js';
import { RulesService } from './workflows/rules.service.js';

@Module({
  imports: [CoreModule.forRoot({ schema: 'integration', control: true, tenant: true, relay: true }), EntitlementsModule],
  controllers: [InternalKeysController, FieldsAdminController, FieldsReadController, InternalFieldsController, RulesController, IntegrationsController, FhirController, LisResultsController],
  providers: [FieldCrypto, FieldsService, RulesService, WorkflowConsumers, WebhooksService, ApiKeysService, IntegrationAudit, LisService, IntegrationConsumers],
})
export class AppModule {}
