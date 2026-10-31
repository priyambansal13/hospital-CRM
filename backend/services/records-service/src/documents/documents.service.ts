import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventTypes, Topics } from '@mc/contracts';
import { DomainError, forbidden, notFound, REDIS, type Redis, dateOnly } from '@mc/nest-common';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash, randomUUID } from 'node:crypto';
import { RecordAccess } from '../records/access.js';
import { AuditClient } from '../records/audit.client.js';
import { TimelineService } from '../timeline/timeline.service.js';
import { ALLOWED, type AllowedMime, detectMime, extensionFor, MAX_BYTES } from './magic.js';
import { VIRUS_SCANNER, type VirusScanner } from './scanner.js';
import { ObjectStorage } from './storage.js';

const URL_TTL_S = 300;
interface UploadIntent { patientId: string; key: string; mime: AllowedMime; size: number; actorId: string; fileName: string }

export const toDocument = (r: any) => ({
  id: r.id, patientId: r.patient_id, type: r.type, title: r.title, source: r.source, mimeType: r.mime_type, sizeBytes: Number(r.size_bytes),
  scanStatus: r.scan_status, scanDetail: r.scan_status === 'CLEAN' || r.scan_status === 'PENDING' || r.scan_status === 'SCANNING' ? null : r.scan_detail,
  issuedOn: dateOnly(r.issued_on), uploadedBy: { kind: r.uploaded_by_kind, name: r.uploaded_by_name }, createdAt: r.created_at,
});

/**
 * Medical documents (docs/LLD.md §10): the browser uploads straight to the hospital's bucket with a 5-minute
 * presigned PUT into quarantine/; nothing is visible until the scan job has checked the bytes (type by magic bytes,
 * size, SHA-256, virus scan) and moved it to clean/. Downloads are 5-minute presigned GETs, audited.
 */
@Injectable()
export class DocumentsService {
  private readonly log = new Logger('Documents');

  constructor(
    private readonly db: TenantDbRouter,
    private readonly storage: ObjectStorage,
    private readonly access: RecordAccess,
    private readonly audit: AuditClient,
    private readonly timeline: TimelineService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
  ) {}

  private bucket() { return this.storage.bucketFor(TenantContext.require().slug); }

  /** Patients (self/family) and doctors treating the patient may upload; consent/break-glass readers may not. */
  private async assertCanUpload(c: Queryable, actor: Actor, patientId: string) {
    const d = await this.access.assertCanRead(c, actor, patientId, 'DOCUMENT');
    if (d.purpose !== 'PATIENT_SELF' && d.purpose !== 'TREATMENT') throw forbidden('UPLOAD_NOT_ALLOWED', 'only the patient or a treating doctor can add documents');
    return d;
  }

  async requestUpload(actor: Actor, patientId: string, v: { fileName: string; mimeType: string; sizeBytes: number }) {
    if (!(v.mimeType in ALLOWED)) throw new DomainError(422, 'FILE_TYPE_NOT_ALLOWED', `only ${Object.values(ALLOWED).join(', ')} files`);
    if (v.sizeBytes > MAX_BYTES) throw new DomainError(422, 'FILE_TOO_LARGE', `files can be at most ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
    await this.assertCanUpload(await this.db.current(), actor, patientId);
    const bucket = this.bucket();
    await this.storage.ensureBucket(bucket);
    const uploadId = randomUUID();
    const key = `quarantine/${patientId}/${uploadId}`;
    const intent: UploadIntent = { patientId, key, mime: v.mimeType as AllowedMime, size: v.sizeBytes, actorId: actor.id, fileName: v.fileName };
    await this.redis.set(`upload:${TenantContext.require().id}:${uploadId}`, JSON.stringify(intent), 'EX', 15 * 60);
    return { uploadId, url: await this.storage.presignPut(bucket, key, v.mimeType, URL_TTL_S), method: 'PUT', headers: { 'content-type': v.mimeType }, expiresIn: URL_TTL_S };
  }

  /** After the PUT: record the document as PENDING; the scan job takes it from there. */
  async register(actor: Actor, patientId: string, v: { uploadId: string; title: string; type: string; issuedOn: string | null }) {
    const rkey = `upload:${TenantContext.require().id}:${v.uploadId}`;
    const raw = await this.redis.get(rkey);
    const intent = raw ? (JSON.parse(raw) as UploadIntent) : null;
    if (!intent || intent.patientId !== patientId || intent.actorId !== actor.id) throw notFound('upload');
    const head = await this.storage.head(this.bucket(), intent.key);
    if (!head) throw new DomainError(422, 'UPLOAD_MISSING', 'the file has not arrived yet; upload it first');
    return this.db.tx(async (c) => {
      const d = await this.assertCanUpload(c, actor, patientId);
      const id = v.uploadId;
      const { rows: [r] } = await c.query(
        `INSERT INTO medical_documents (id, patient_id, type, title, source, storage_key, mime_type, size_bytes, issued_on, uploaded_by, uploaded_by_kind, uploaded_by_name)
         VALUES ($1,$2,$3,$4,'UPLOADED',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [id, patientId, v.type, v.title, intent.key, intent.mime, head.size, v.issuedOn, actor.id, actor.kind, d.actorName]);
      await this.audit.record({ actorId: actor.id, actorKind: actor.kind, actorName: d.actorName, action: 'CREATE', resourceType: 'DOCUMENT', resourceId: id, patientId, purpose: d.purpose });
      await this.redis.del(rkey);
      return toDocument(r);
    });
  }

  async list(actor: Actor, patientId: string) {
    const c = await this.db.current();
    const d = await this.access.assertCanRead(c, actor, patientId, 'DOCUMENT_LIST');
    await this.audit.record({ actorId: actor.id, actorKind: actor.kind, actorName: d.actorName, action: 'READ', resourceType: 'DOCUMENT_LIST', patientId, purpose: d.purpose });
    // the patient also sees their uploads still being checked (or refused); others only see clean documents
    const { rows } = await c.query(
      `SELECT * FROM medical_documents WHERE patient_id = $1 AND deleted_at IS NULL AND superseded_by IS NULL ${d.purpose === 'PATIENT_SELF' ? '' : `AND scan_status = 'CLEAN'`} ORDER BY coalesce(issued_on, created_at::date) DESC, created_at DESC LIMIT 200`, [patientId]);
    return rows.map(toDocument);
  }

  async get(actor: Actor, id: string) {
    const c = await this.db.current();
    const { rows } = await c.query('SELECT * FROM medical_documents WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!rows[0]) throw notFound('document');
    const d = await this.access.assertCanRead(c, actor, rows[0].patient_id, 'DOCUMENT');
    if (d.purpose !== 'PATIENT_SELF' && rows[0].scan_status !== 'CLEAN') throw notFound('document');
    return toDocument(rows[0]);
  }

  /** A 5-minute download link (attachment), audited as EXPORT. Only clean documents. */
  async download(actor: Actor, id: string) {
    const c = await this.db.current();
    const { rows } = await c.query('SELECT * FROM medical_documents WHERE id = $1 AND deleted_at IS NULL', [id]);
    const doc = rows[0];
    if (!doc) throw notFound('document');
    const d = await this.access.assertCanRead(c, actor, doc.patient_id, 'DOCUMENT');
    if (doc.scan_status !== 'CLEAN') throw new DomainError(409, 'NOT_AVAILABLE', doc.scan_status === 'PENDING' || doc.scan_status === 'SCANNING' ? 'still being checked' : 'this file was refused');
    await this.audit.record({ actorId: actor.id, actorKind: actor.kind, actorName: d.actorName, action: 'EXPORT', resourceType: 'DOCUMENT', resourceId: id, patientId: doc.patient_id, purpose: d.purpose });
    const name = `${doc.title}.${extensionFor(doc.mime_type as AllowedMime)}`;
    return { url: await this.storage.presignGet(this.bucket(), doc.storage_key, name, doc.mime_type, URL_TTL_S), expiresIn: URL_TTL_S };
  }

  /** The uploader can remove their own document (soft delete; the file goes when the retention job runs). */
  async remove(actor: Actor, id: string) {
    await this.db.tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM medical_documents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
      const doc = rows[0];
      if (!doc) throw notFound('document');
      const d = await this.access.assertCanRead(c, actor, doc.patient_id, 'DOCUMENT');
      if (doc.uploaded_by !== actor.id) throw forbidden('NOT_UPLOADER', 'only whoever added a document can remove it');
      await c.query('UPDATE medical_documents SET deleted_at = now() WHERE id = $1', [id]);
      await this.timeline.remove(c, 'DOCUMENT', id);
      await this.audit.record({ actorId: actor.id, actorKind: actor.kind, actorName: d.actorName, action: 'UPDATE', resourceType: 'DOCUMENT', resourceId: id, patientId: doc.patient_id, purpose: d.purpose, changes: ['deleted'] });
    });
  }

  /**
   * Retention (review H-5): a removed document is kept DOCUMENT_PURGE_DAYS (30) in case it was removed by mistake,
   * then the file and the record are deleted for good. Returns how many.
   */
  async purgeRemoved() {
    const days = Number(process.env.DOCUMENT_PURGE_DAYS ?? 30);
    const c = await this.db.current();
    const { rows } = await c.query('SELECT id, storage_key FROM medical_documents WHERE deleted_at < now() - make_interval(days => $1) LIMIT 100', [days]);
    for (const d of rows) {
      await this.storage.delete(this.bucket(), d.storage_key).catch(() => undefined); // already gone is fine
      await c.query('UPDATE medical_documents SET superseded_by = NULL WHERE superseded_by = $1', [d.id]);
      await c.query('DELETE FROM medical_documents WHERE id = $1', [d.id]);
    }
    return rows.length;
  }

  /**
   * A document produced by the hospital itself (e.g. a verified lab report PDF): stored straight in clean/ (no scan
   * needed for our own output), on the timeline, optionally replacing an earlier version.
   */
  async storeInternal(v: { patientId: string; type: string; title: string; mimeType: AllowedMime; content: Buffer; relatedType: string | null; relatedId: string | null; issuedOn: string | null;
    byUserId: string; byName: string | null; supersedes: string | null; timeline: { kind: 'REPORT'; refId: string; title: string; summary: Record<string, unknown> } | null }) {
    if (!(await this.access.patient(await this.db.current(), v.patientId))) throw notFound('patient');
    const bucket = this.bucket();
    await this.storage.ensureBucket(bucket);
    const id = randomUUID();
    const key = `clean/${v.patientId}/${id}.${extensionFor(v.mimeType)}`;
    await this.storage.put(bucket, key, v.content, v.mimeType);
    return this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO medical_documents (id, patient_id, type, title, source, storage_key, mime_type, size_bytes, sha256, scan_status, scan_detail, issued_on, related_type, related_id, uploaded_by, uploaded_by_kind, uploaded_by_name)
         VALUES ($1,$2,$3,$4,'INTERNAL',$5,$6,$7,$8,'CLEAN','generated by MediCare',$9,$10,$11,$12,'staff',$13)`,
        [id, v.patientId, v.type, v.title, key, v.mimeType, v.content.length, createHash('sha256').update(v.content).digest('hex'), v.issuedOn, v.relatedType, v.relatedId, v.byUserId, v.byName]);
      if (v.supersedes) await c.query('UPDATE medical_documents SET superseded_by = $2 WHERE id = $1 AND superseded_by IS NULL', [v.supersedes, id]);
      if (v.timeline) await this.timeline.upsert(c, { patientId: v.patientId, kind: v.timeline.kind, refId: v.timeline.refId, occurredAt: new Date(), title: v.timeline.title, summary: { ...v.timeline.summary, documentId: id } });
      return { documentId: id };
    });
  }

  /**
   * Scan job, one hospital: claim (PENDING, or SCANNING abandoned > 2 min) → check bytes outside any transaction →
   * save the verdict. Fails safe: a file is only ever shown after a scanner said it is clean.
   */
  async scanPending(): Promise<number> {
    const bucket = this.bucket();
    const claimed = await this.db.tx(async (c) => (await c.query(
      `UPDATE medical_documents SET scan_status = 'SCANNING', scan_attempts = scan_attempts + 1, scan_claimed_at = now()
       WHERE id IN (SELECT id FROM medical_documents WHERE deleted_at IS NULL AND (scan_status = 'PENDING' OR (scan_status = 'SCANNING' AND scan_claimed_at < now() - interval '2 minutes'))
                    ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
       RETURNING *`)).rows);
    let n = 0;
    for (const doc of claimed) {
      try {
        const verdict = await this.check(bucket, doc);
        await this.db.tx((c) => this.saveVerdict(c, bucket, doc, verdict));
        n++;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 200);
        this.log.warn(`${TenantContext.require().slug}: scan of ${doc.id} failed (attempt ${doc.scan_attempts}): ${msg}`);
        // never "clean" on error: retry, then refuse
        await this.db.query(`UPDATE medical_documents SET scan_status = CASE WHEN scan_attempts >= 5 THEN 'REJECTED' ELSE 'PENDING' END, scan_detail = $2 WHERE id = $1 AND scan_status = 'SCANNING'`,
          [doc.id, `could not be scanned: ${msg}`]);
        if (doc.scan_attempts >= 5) await this.storage.delete(bucket, doc.storage_key).catch(() => undefined);
      }
    }
    return n;
  }

  private async check(bucket: string, doc: any): Promise<{ status: 'CLEAN' | 'INFECTED' | 'REJECTED'; detail: string | null; sha256: string | null; size: number; mime: AllowedMime | null }> {
    const head = await this.storage.head(bucket, doc.storage_key);
    if (!head) return { status: 'REJECTED', detail: 'the file never arrived', sha256: null, size: 0, mime: null };
    if (head.size > MAX_BYTES) return { status: 'REJECTED', detail: `larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB`, sha256: null, size: head.size, mime: null };
    const bytes = await this.storage.read(bucket, doc.storage_key);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const mime = detectMime(bytes);
    if (!mime) return { status: 'REJECTED', detail: 'not a PDF, JPEG, PNG or DICOM file', sha256, size: bytes.length, mime };
    if (mime !== doc.mime_type) return { status: 'REJECTED', detail: `content is ${ALLOWED[mime]}, not ${ALLOWED[doc.mime_type as AllowedMime] ?? doc.mime_type}`, sha256, size: bytes.length, mime };
    const r = await this.scanner.scan(bytes);
    if (!r.clean) return { status: 'INFECTED', detail: `${r.signature} (${r.engine})`, sha256, size: bytes.length, mime };
    return { status: 'CLEAN', detail: `scanned by ${r.engine}`, sha256, size: bytes.length, mime };
  }

  private async saveVerdict(c: Queryable, bucket: string, doc: any, v: Awaited<ReturnType<DocumentsService['check']>>) {
    if (v.status === 'CLEAN') {
      const cleanKey = `clean/${doc.patient_id}/${doc.id}.${extensionFor(v.mime!)}`;
      await this.storage.move(bucket, doc.storage_key, cleanKey);
      await c.query(`UPDATE medical_documents SET scan_status = 'CLEAN', scan_detail = $2, sha256 = $3, size_bytes = $4, storage_key = $5 WHERE id = $1`, [doc.id, v.detail, v.sha256, v.size, cleanKey]);
      await this.timeline.upsert(c, { patientId: doc.patient_id, kind: 'DOCUMENT', refId: doc.id, occurredAt: doc.issued_on ?? doc.created_at, title: doc.title, summary: { type: doc.type, by: doc.uploaded_by_kind, mime: doc.mime_type } });
      await addToOutbox(c, Topics.records, doc.patient_id, envelope(EventTypes.documentAvailable, { documentId: doc.id, patientId: doc.patient_id, type: doc.type }, { tenantId: TenantContext.require().id, subject: doc.id }));
    } else {
      await this.storage.delete(bucket, doc.storage_key).catch(() => undefined);
      await c.query(`UPDATE medical_documents SET scan_status = $2, scan_detail = $3, sha256 = $4 WHERE id = $1`, [doc.id, v.status, v.detail, v.sha256]);
    }
  }
}
