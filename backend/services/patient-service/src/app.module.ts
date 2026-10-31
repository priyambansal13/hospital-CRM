import { Module } from '@nestjs/common';
import { CoreModule, CustomFieldsClient } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { AuditClient } from './patients/audit.client.js';
import { MyClinicalController, StaffAllergiesController } from './patients/clinical.controller.js';
import { DeskPatientsController, PatientFieldsController } from './patients/desk.controller.js';
import { InternalPatientsController, MyPatientsController } from './patients/patients.controller.js';

@Module({
  imports: [CoreModule.forRoot({ schema: 'patient', control: false, tenant: true, relay: true }), EntitlementsModule],
  controllers: [MyPatientsController, InternalPatientsController, DeskPatientsController, MyClinicalController, StaffAllergiesController, PatientFieldsController],
  providers: [AuditClient, CustomFieldsClient],
})
export class AppModule {}
