import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventTypes, Topics, type TenantProvisioned } from '@mc/contracts';
import { CONTROL_DB, conflict, DomainError } from '@mc/nest-common';
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
      const { rows } = await c.query('UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1 RETURNING slug', [id, status]);
      if (!rows[0]) throw new DomainError(404, 'NOT_FOUND', 'tenant not found');
      await addToOutbox(c, Topics.tenant, id, envelope(EventTypes.tenantUpdated, { tenantId: id, slug: rows[0].slug, status }, { tenantId: id, subject: id }));
    });
  }

  async recordSchemaVersion(tenantId: string, service: string, version: string) {
    await this.db.query(`INSERT INTO tenant_schema_versions (tenant_id, service, version) VALUES ($1,$2,$3)
      ON CONFLICT (tenant_id, service) DO UPDATE SET version = EXCLUDED.version, applied_at = now()`, [tenantId, service, version]);
  }

  async updateBranding(id: string, branding: Record<string, unknown>, name?: string) {
    await this.db.query(`UPDATE tenants SET branding = branding || $2::jsonb, name = coalesce($3, name), updated_at = now() WHERE id = $1`, [id, JSON.stringify(branding), name ?? null]);
  }
}
