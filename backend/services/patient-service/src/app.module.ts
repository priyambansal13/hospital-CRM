import { Module } from '@nestjs/common';
import { CoreModule } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { AuditClient } from './patients/audit.client.js';
import { MyClinicalController, StaffAllergiesController } from './patients/clinical.controller.js';
import { DeskPatientsController } from './patients/desk.controller.js';
import { InternalPatientsController, MyPatientsController } from './patients/patients.controller.js';

@Module({
  imports: [CoreModule.forRoot({ schema: 'patient', control: false, tenant: true, relay: true }), EntitlementsModule],
  controllers: [MyPatientsController, InternalPatientsController, DeskPatientsController, MyClinicalController, StaffAllergiesController],
  providers: [AuditClient],
})
export class AppModule {}
