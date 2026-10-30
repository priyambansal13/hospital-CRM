import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventTypes, Topics, type TenantProvisioned } from '@mc/contracts';
import { CONTROL_DB, conflict, DomainError, isDev } from '@mc/nest-common';
import { addToOutbox, envelope, serviceDbConfig, survive, withTx } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CatalogRepo, type TenantRow } from './catalog.repo.js';

export interface CreateTenantInput {
  slug: string;
  name: string;
  adminEmail: string;
  plan?: string;
  source?: 'SALES' | 'SIGNUP';
  adminName?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Provisioning saga (docs/MULTI-TENANCY.md §6, §3.3). Each step is idempotent and recorded, so a failed run can be
 * retried by calling create() again with the same slug.
 */
@Injectable()
export class ProvisioningService {
  private readonly log = new Logger('Provisioning');
  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool, private readonly catalog: CatalogRepo) {}

  async create(input: CreateTenantInput): Promise<TenantRow> {
    const existing = await this.catalog.findBySlug(input.slug);
    if (existing && existing.status !== 'PROVISIONING') throw conflict('TENANT_EXISTS', `tenant ${input.slug} already exists`);
    const id = existing?.id ?? randomUUID();
    const dbName = `t_${input.slug.replaceAll('-', '_')}`;
    const host = `${input.slug}.${process.env.TENANT_BASE_DOMAIN ?? 'localhost'}`;

    if (!existing) {
      await withTx(this.db, async (c) => {
        await c.query(
          `INSERT INTO tenants (id, slug, name, status, db_name, db_host, db_port, plan, admin_email, branding, source)
           VALUES ($1,$2,$3,'PROVISIONING',$4,$5,$6,$7,$8,$9,$10)`,
          [id, input.slug, input.name, dbName, process.env.PG_HOST ?? 'localhost', Number(process.env.PG_PORT ?? 61432), input.plan ?? null, input.adminEmail,
            { primaryColor: '#0f766e', accentColor: '#f59e0b', logoUrl: null }, input.source ?? 'SALES'],
        );
        await c.query('INSERT INTO tenant_domains (host, tenant_id, is_primary) VALUES ($1, $2, true)', [host, id]);
      });
    }

    await this.step(id, 'create_database', () => this.createDatabase(dbName));
    await this.step(id, 'tenant_meta', () => this.writeTenantMeta(dbName, id, input.slug));

    await withTx(this.db, async (c) => {
      await c.query(`UPDATE tenants SET status = 'ACTIVE', updated_at = now() WHERE id = $1`, [id]);
      const data: TenantProvisioned = { tenantId: id, slug: input.slug, name: input.name, adminEmail: input.adminEmail, hosts: [host], plan: input.plan ?? null, source: input.source ?? 'SALES', adminName: input.adminName ?? null };
      await addToOutbox(c, Topics.tenant, id, envelope(EventTypes.tenantProvisioned, data, { tenantId: id, subject: id }));
    });
    this.log.log(`provisioned ${input.slug} → ${dbName}`);
    return (await this.catalog.find(id))!;
  }

  private async step(tenantId: string, step: string, fn: () => Promise<void>) {
    const { rows } = await this.db.query(`SELECT status FROM provisioning_steps WHERE tenant_id = $1 AND step = $2`, [tenantId, step]);
    if (rows[0]?.status === 'DONE') return;
    try {
      await fn();
      await this.db.query(`INSERT INTO provisioning_steps (tenant_id, step, status) VALUES ($1,$2,'DONE')
        ON CONFLICT (tenant_id, step) DO UPDATE SET status = 'DONE', detail = NULL, updated_at = now()`, [tenantId, step]);
    } catch (e) {
      await this.db.query(`INSERT INTO provisioning_steps (tenant_id, step, status, detail) VALUES ($1,$2,'FAILED',$3)
        ON CONFLICT (tenant_id, step) DO UPDATE SET status = 'FAILED', detail = $3, updated_at = now()`, [tenantId, step, (e as Error).message]);
      throw new DomainError(500, 'PROVISIONING_FAILED', `step ${step} failed: ${(e as Error).message}`);
    }
  }

  /** CREATE DATABASE … TEMPLATE medicare_template: every schema at the latest version in seconds. */
  private async createDatabase(dbName: string) {
    if (!/^t_[a-z0-9_]+$/.test(dbName)) throw new Error(`bad db name ${dbName}`);
    const { rows } = await this.db.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length) return;
    const template = process.env.TEMPLATE_DB ?? 'medicare_template';
    // The template must have no open connections (a migration may be running): retry briefly.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.db.query(`CREATE DATABASE ${dbName} TEMPLATE ${template}`);
        return;
      } catch (e) {
        if (attempt >= 10 || !/being accessed by other users/.test((e as Error).message)) throw e;
        await sleep(500 * attempt);
      }
    }
  }

  private async writeTenantMeta(dbName: string, tenantId: string, slug: string) {
    const cfg = serviceDbConfig('tenant');
    const c = new pg.Client({ host: process.env.PG_HOST ?? 'localhost', port: Number(process.env.PG_PORT ?? 61432), database: dbName, user: cfg.user, password: cfg.password });
    survive(c, 'provisioning');
    await c.connect();
    try {
      await c.query('INSERT INTO public.tenant_meta (tenant_id, slug) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenantId, slug]);
    } finally {
      await c.end();
    }
  }

  async setStatus(id: string, status: TenantRow['status']) {
    await withTx(this.db, async (c) => {
      const { rows } = await c.query(`UPDATE tenants SET status = $2, updated_at = now(), deleted_at = CASE WHEN $2 = 'DELETED' THEN coalesce(deleted_at, now()) ELSE NULL END
        WHERE id = $1 AND purged_at IS NULL RETURNING slug`, [id, status]);
      if (!rows[0]) throw new DomainError(404, 'NOT_FOUND', 'tenant not found');
      await addToOutbox(c, Topics.tenant, id, envelope(EventTypes.tenantUpdated, { tenantId: id, slug: rows[0].slug, status }, { tenantId: id, subject: id }));
    });
  }

  /**
   * Offboarding (review H-1): destroy a deleted hospital's data once the retention period has passed. Documents and
   * search indexes are removed, data keys destroyed (crypto-shredding: encrypted notes and chats in any backup become
   * unreadable), then the database is dropped. Export it first (`mc tenant export`). Not reversible.
   */
  async purge(id: string, opts: { force?: boolean } = {}) {
    const { rows: [t] } = await this.db.query('SELECT id, slug, status, db_name, deleted_at, purged_at FROM tenants WHERE id = $1', [id]);
    if (!t) throw new DomainError(404, 'NOT_FOUND', 'tenant not found');
    if (t.purged_at) return { tenantId: id, slug: t.slug, alreadyPurged: true };
    assertPurgeable(t, { now: new Date(), days: Number(process.env.PURGE_AFTER_DAYS ?? 30), force: !!opts.force, dev: isDev() });
    const done: Record<string, unknown> = {};
    for (const [svc, port] of [['RECORDS', 4410], ['ASSISTANT', 4415], ['SEARCH', 4414]] as const) {
      const base = process.env[`SVC_URL_${svc}`] ?? `http://localhost:${port}`;
      const res = await fetch(`${base}/internal/tenants/${id}/purge-data/${t.slug}`, { method: 'POST', headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new DomainError(502, 'PURGE_FAILED', `${svc.toLowerCase()} could not purge (${res.status}): nothing else was removed after it; run again`);
      done[svc.toLowerCase()] = await res.json();
    }
    if (!/^t_[a-z0-9_]+$/.test(t.db_name)) throw new Error(`bad db name ${t.db_name}`);
    await this.db.query(`DROP DATABASE IF EXISTS ${t.db_name} WITH (FORCE)`);
    await this.db.query('UPDATE tenants SET purged_at = now(), updated_at = now() WHERE id = $1', [id]);
    this.log.warn(`${t.slug}: purged (database ${t.db_name} dropped, data keys destroyed)`);
    return { tenantId: id, slug: t.slug, database: t.db_name, ...done };
  }

  async recordSchemaVersion(tenantId: string, service: string, version: string) {
    await this.db.query(`INSERT INTO tenant_schema_versions (tenant_id, service, version) VALUES ($1,$2,$3)
      ON CONFLICT (tenant_id, service) DO UPDATE SET version = EXCLUDED.version, applied_at = now()`, [tenantId, service, version]);
  }

  async updateBranding(id: string, branding: Record<string, unknown>, name?: string) {
    await this.db.query(`UPDATE tenants SET branding = branding || $2::jsonb, name = coalesce($3, name), updated_at = now() WHERE id = $1`, [id, JSON.stringify(branding), name ?? null]);
  }
}

/** May this hospital's data be destroyed now? Only DELETED, only after the retention period (dev may force). */
export function assertPurgeable(t: { status: string; deleted_at: Date | string | null }, o: { now: Date; days: number; force: boolean; dev: boolean }) {
  if (t.status !== 'DELETED' || !t.deleted_at) throw new DomainError(409, 'NOT_DELETED', 'only a deleted hospital can be purged: delete it first');
  const due = new Date(new Date(t.deleted_at).getTime() + o.days * 86_400_000);
  if (due.getTime() > o.now.getTime() && !(o.force && o.dev)) throw new DomainError(409, 'RETENTION', `kept until ${due.toISOString().slice(0, 10)} (${o.days} days after deletion)`);
}
