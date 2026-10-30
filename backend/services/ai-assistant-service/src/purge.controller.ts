import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CONTROL_DB, destroyTenantKeys, Internal, notFound } from '@mc/nest-common';
import type pg from 'pg';
import { z } from 'zod';

/** tenant-service purging a deleted hospital (review H-1): the chat encryption keys go for good. */
@Controller('internal/tenants/:tenantId/purge-data')
export class InternalPurgeController {
  constructor(@Inject(CONTROL_DB) private readonly control: pg.Pool) {}

  @Post(':slug')
  @Internal()
  @HttpCode(200)
  async purge(@Param('tenantId') tenantId: string) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    return { keysDestroyed: await destroyTenantKeys(this.control, tenantId) };
  }
}
