import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentActor, Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { RequireModule } from '@mc/entitlements-sdk';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { RecordAccess, type Scope } from '../records/access.js';
import { type Kind, TimelineService } from '../timeline/timeline.service.js';
import { DocumentsService } from './documents.service.js';
import { ObjectStorage } from './storage.js';
import { FieldCrypto } from '../crypto/field-crypto.js';

const Uuid = z.uuid();
const id = (v: string, what: string) => { if (!Uuid.safeParse(v ?? '').success) throw notFound(what); return v; };
const UploadUrl = z.object({ fileName: z.string().trim().min(1).max(200), mimeType: z.string().max(60), sizeBytes: z.number().int().positive() });
const Register = z.object({
  uploadId: z.uuid(), title: z.string().trim().min(2).max(200),
  type: z.enum(['LAB_REPORT', 'PRESCRIPTION', 'DISCHARGE', 'IMAGING', 'EXTERNAL', 'OTHER']).default('EXTERNAL'),
  issuedOn: z.iso.date().refine((d) => d <= new Date().toISOString().slice(0, 10), 'cannot be in the future').nullable().default(null),
});
const KINDS = ['APPOINTMENT', 'ENCOUNTER', 'PRESCRIPTION', 'LAB_ORDER', 'REPORT', 'DOCUMENT'] as const;
const TimelineQ = z.object({ kind: z.string().optional(), beforeAt: z.iso.datetime({ offset: true }).optional(), beforeId: z.uuid().optional() });

/** Documents and the health timeline. Patients (own/family) and doctors (policy decides; everything audited). */
@Controller('v1')
@RequireModule('emr')
export class DocumentsController {
  constructor(private readonly docs: DocumentsService, private readonly timeline: TimelineService) {}

  @Post('patients/:patientId/documents/upload-url')
  @HttpCode(200)
  uploadUrl(@Param('patientId') p: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.docs.requestUpload(actor, id(p, 'patient'), parse(UploadUrl, body));
  }

  @Post('patients/:patientId/documents')
  register(@Param('patientId') p: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.docs.register(actor, id(p, 'patient'), parse(Register, body));
  }

  @Get('patients/:patientId/documents')
  list(@Param('patientId') p: string, @CurrentActor() actor: Actor) {
    return this.docs.list(actor, id(p, 'patient'));
  }

  @Get('documents/:id')
  get(@Param('id') d: string, @CurrentActor() actor: Actor) {
    return this.docs.get(actor, id(d, 'document'));
  }

  @Get('documents/:id/download')
  download(@Param('id') d: string, @CurrentActor() actor: Actor) {
    return this.docs.download(actor, id(d, 'document'));
  }

  @Delete('documents/:id')
  @HttpCode(204)
  remove(@Param('id') d: string, @CurrentActor() actor: Actor) {
    return this.docs.remove(actor, id(d, 'document'));
  }

  @Get('patients/:patientId/timeline')
  page(@Param('patientId') p: string, @Query() query: unknown, @CurrentActor() actor: Actor) {
    const q = parse(TimelineQ, query);
    const kinds = q.kind ? (q.kind.split(',').filter((k) => (KINDS as readonly string[]).includes(k)) as Kind[]) : undefined;
    return this.timeline.page(actor, id(p, 'patient'), { kinds, before: q.beforeAt && q.beforeId ? { at: q.beforeAt, id: q.beforeId } : undefined });
  }
}

const StoreInternal = z.object({
  patientId: z.uuid(), type: z.enum(['LAB_REPORT', 'PRESCRIPTION', 'DISCHARGE', 'IMAGING', 'OTHER']), title: z.string().min(2).max(200),
  mimeType: z.literal('application/pdf'), contentBase64: z.string().min(10).max(14_000_000),
  relatedType: z.string().max(30).nullable().default(null), relatedId: z.uuid().nullable().default(null), issuedOn: z.iso.date().nullable().default(null),
  byUserId: z.uuid(), byName: z.string().max(120).nullable().default(null), supersedes: z.uuid().nullable().default(null),
  timeline: z.object({ kind: z.literal('REPORT'), refId: z.uuid(), title: z.string().max(200), summary: z.record(z.string(), z.unknown()) }).nullable().default(null),
});

/** Service-to-service: store a document the hospital produced (diagnostics' verified report PDFs). */
@Controller('internal/tenants/:tenantId/documents')
export class InternalDocumentsController {
  constructor(private readonly docs: DocumentsService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post()
  @Internal()
  async store(@Param('tenantId') t: string, @Body() body: unknown) {
    id(t, 'tenant');
    const v = parse(StoreInternal, body);
    const content = Buffer.from(v.contentBase64, 'base64');
    if (content.subarray(0, 5).toString('latin1') !== '%PDF-') throw notFound('document');
    return TenantContext.run(await this.placements.get(t), () => this.docs.storeInternal({ ...v, content }));
  }
}

/**
 * Service-to-service: may this staff user see this patient's clinical data (and why)? One policy for every service
 * holding clinical data (patient-service asks before showing allergies). The caller audits.
 */
@Controller('internal/tenants/:tenantId/care-access')
export class InternalCareAccessController {
  constructor(private readonly db: TenantDbRouter, private readonly access: RecordAccess, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get()
  @Internal()
  async check(@Param('tenantId') t: string, @Query('userId') userId: string, @Query('patientId') patientId: string, @Query('scope') scope: string | undefined) {
    id(t, 'tenant'); id(userId, 'user'); id(patientId, 'patient');
    const sc = (['NOTES', 'PRESCRIPTIONS', 'DOCUMENTS', 'ANY'].includes(scope ?? '') ? scope : 'NOTES') as Scope;
    return TenantContext.run(await this.placements.get(t), async () => {
      const d = await this.access.decide(await this.db.current(), { id: userId, kind: 'staff', token: '' }, patientId, sc);
      return { allowed: !!d, purpose: d?.purpose ?? 'NONE', doctorName: d?.actorName ?? null, doctorId: d?.doctor?.id ?? null };
    });
  }
}

/** Provisioning readiness (tenant-service's signup page): the hospital's bucket and data key exist. */
@Controller('internal/tenants/:tenantId/storage')
export class InternalStorageController {
  constructor(private readonly storage: ObjectStorage, private readonly crypto: FieldCrypto, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get()
  @Internal()
  async status(@Param('tenantId') t: string) {
    id(t, 'tenant');
    const p = await this.placements.get(t);
    return { bucket: await this.storage.bucketExists(this.storage.bucketFor(p.slug)), key: await this.crypto.hasKey(t) };
  }
}
