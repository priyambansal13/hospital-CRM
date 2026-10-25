import { Module } from '@nestjs/common';
import { CoreModule } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { AccessLogController, AuditController, InternalAuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { VerifyJob } from './audit/verify.job.js';

/** Append-only, hash-chained audit log per hospital (docs/LLD.md §15). */
@Module({
  imports: [CoreModule.forRoot({ schema: 'audit', control: false, tenant: true, relay: false }), EntitlementsModule],
  controllers: [AuditController, AccessLogController, InternalAuditController],
  providers: [AuditService, VerifyJob],
})
export class AppModule {}
