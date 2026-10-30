import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { Internal, notFound } from '@mc/nest-common';
import { z } from 'zod';
import { OpenSearch } from './opensearch.js';

/** tenant-service purging a deleted hospital (review H-1): its search indexes are dropped. */
@Controller('internal/tenants/:tenantId/purge-data')
export class InternalPurgeController {
  constructor(private readonly os: OpenSearch) {}

  @Post(':slug')
  @Internal()
  @HttpCode(200)
  async purge(@Param('tenantId') tenantId: string) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    for (const kind of ['doctors', 'tests'] as const) await this.os.drop(this.os.index(tenantId, kind));
    return { indexesDropped: 2 };
  }
}
