import { Injectable } from '@nestjs/common';
import {
  CopyObjectCommand, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand,
  PutObjectCommand, PutPublicAccessBlockCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * S3-compatible object storage (MinIO locally; any S3 / GCS-interop endpoint in the cloud). One private bucket per
 * hospital (docs/MULTI-TENANCY.md §5): `<prefix><slug>`. Browsers only ever get 5-minute presigned URLs.
 * Two clients: one for the service (internal endpoint), one that signs URLs for the browser's view of the host.
 */
@Injectable()
export class ObjectStorage {
  private readonly cfg = {
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? '', secretAccessKey: process.env.S3_SECRET_KEY ?? '' },
  };
  private readonly s3 = new S3Client({ ...this.cfg, endpoint: process.env.S3_ENDPOINT });
  private readonly signer = new S3Client({ ...this.cfg, endpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT });
  private readonly ready = new Set<string>();

  bucketFor(slug: string) {
    return `${process.env.S3_BUCKET_PREFIX ?? 'medicare-dev-t-'}${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);
  }

  async bucketExists(bucket: string) {
    return this.s3.send(new HeadBucketCommand({ Bucket: bucket })).then(() => true, () => false);
  }

  /** Create the hospital's bucket on first use, with public access blocked where the store supports it. */
  async ensureBucket(bucket: string) {
    if (this.ready.has(bucket)) return;
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: bucket })).catch((e) => { if (!/BucketAlready/.test(String(e?.name))) throw e; });
      await this.s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } })).catch(() => undefined);
    }
    this.ready.add(bucket);
  }

  presignPut(bucket: string, key: string, contentType: string, ttl = 300) {
    return getSignedUrl(this.signer, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: ttl });
  }

  presignGet(bucket: string, key: string, filename: string, contentType: string, ttl = 300) {
    const safe = filename.replace(/[^\w.\- ]/g, '_').slice(0, 100);
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${safe}"`, ResponseContentType: contentType }), { expiresIn: ttl });
  }

  async head(bucket: string, key: string): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const h = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: Number(h.ContentLength ?? 0), contentType: h.ContentType ?? null };
    } catch (e) {
      if ((e as any)?.$metadata?.httpStatusCode === 404 || (e as any)?.name === 'NotFound') return null;
      throw e;
    }
  }

  async read(bucket: string, key: string): Promise<Buffer> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  async put(bucket: string, key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async move(bucket: string, from: string, to: string) {
    await this.s3.send(new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${encodeURIComponent(from).replace(/%2F/g, '/')}` }));
    await this.delete(bucket, from);
  }

  async delete(bucket: string, key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
