import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CONTROL_DB, destroyTenantKeys, Internal, notFound, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import type pg from 'pg';
import { z } from 'zod';
import { ObjectStorage } from './documents/storage.js';

/** tenant-service purging a deleted hospital (review H-1): its documents and its data keys go for good. */
@Controller('internal/tenants/:tenantId/purge-data')
export class InternalPurgeController {
  constructor(@Inject(CONTROL_DB) private readonly control: pg.Pool, private readonly storage: ObjectStorage) {}

  @Post(':slug')
  @Internal()
  @HttpCode(200)
  async purge(@Param('tenantId') tenantId: string, @Param('slug') slug: string) {
    if (!z.uuid().safeParse(tenantId).success || !/^[a-z0-9]{3,40}$/.test(slug)) throw notFound('tenant');
    const objects = await this.storage.destroyBucket(this.storage.bucketFor(slug));
    return { keysDestroyed: await destroyTenantKeys(this.control, tenantId), objectsDeleted: objects };
  }
}

/**
 * Offboarding export (review H-1, `mc tenant export`): every stored document of the hospital with a short-lived
 * download link, so the CLI can copy them next to the database dump. The links expire in 15 minutes.
 */
@Controller('internal/tenants/:tenantId/export')
export class InternalExportController {
  constructor(private readonly db: TenantDbRouter, private readonly storage: ObjectStorage, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get('documents')
  @Internal()
  async documents(@Param('tenantId') tenantId: string) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    const t = await this.placements.get(tenantId);
    // a deleted hospital is exported once more before it is purged
    return TenantContext.run(t, async () => {
      const { rows } = await this.db.forExport(tenantId, (pool) => pool.query(`SELECT id, patient_id, type, title, storage_key, mime_type, size_bytes, issued_on, created_at FROM medical_documents WHERE scan_status = 'CLEAN' ORDER BY created_at`));
      const bucket = this.storage.bucketFor(t.slug);
      return Promise.all(rows.map(async (d) => ({
        id: d.id, patientId: d.patient_id, type: d.type, title: d.title, mimeType: d.mime_type, sizeBytes: Number(d.size_bytes ?? 0), issuedOn: d.issued_on, createdAt: d.created_at,
        file: `${d.id}${d.mime_type === 'application/pdf' ? '.pdf' : d.mime_type?.startsWith('image/') ? `.${d.mime_type.split('/')[1]}` : ''}`,
        url: await this.storage.presignGet(bucket, d.storage_key, d.id, d.mime_type, 900),
      })));
    });
  }
}
