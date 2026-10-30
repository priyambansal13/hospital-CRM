import { Inject, Injectable } from '@nestjs/common';
import type { TenantPlacement } from '@mc/contracts';
import { CONTROL_DB } from '@mc/nest-common';
import { normalizeHost, type PlacementSource, TenantNotFoundError } from '@mc/tenancy';
import type pg from 'pg';

// only verified (ACTIVE) domains serve a hospital; a custom domain waiting for its DNS check does not
const SELECT = `SELECT t.id, t.slug, t.name, t.status, t.db_name, t.db_host, t.db_port, t.branding, t.plan, t.admin_email, t.source, t.setup_completed_at,
  coalesce(array_agg(d.host ORDER BY d.is_primary DESC, d.host) FILTER (WHERE d.host IS NOT NULL), '{}') AS hosts
  FROM tenants t LEFT JOIN tenant_domains d ON d.tenant_id = t.id AND d.status = 'ACTIVE'`;

export interface TenantRow extends TenantPlacement {
  branding: Record<string, unknown>;
  plan: string | null;
  adminEmail: string;
  source: 'SALES' | 'SIGNUP';
  setupCompletedAt: Date | null;
}

const toRow = (r: any): TenantRow => ({
  id: r.id, slug: r.slug, name: r.name, status: r.status, dbName: r.db_name, dbHost: r.db_host, dbPort: r.db_port,
  hosts: r.hosts, branding: r.branding, plan: r.plan, adminEmail: r.admin_email, source: r.source, setupCompletedAt: r.setup_completed_at,
});

/** tenant-service reads placements straight from its own catalog; every other service uses HttpPlacementSource. */
@Injectable()
export class CatalogRepo implements PlacementSource {
  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool) {}

  async find(id: string): Promise<TenantRow | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const { rows } = await this.db.query(`${SELECT} WHERE t.id = $1 GROUP BY t.id`, [id]);
    return rows[0] && toRow(rows[0]);
  }
  async findBySlug(slug: string): Promise<TenantRow | undefined> {
    const { rows } = await this.db.query(`${SELECT} WHERE t.slug = $1 GROUP BY t.id`, [slug]);
    return rows[0] && toRow(rows[0]);
  }
  async get(id: string): Promise<TenantPlacement> {
    const t = await this.find(id);
    if (!t) throw new TenantNotFoundError(id);
    return t;
  }
  async resolveHost(host: string): Promise<TenantPlacement> {
    const { rows } = await this.db.query(`${SELECT} WHERE t.id = (SELECT tenant_id FROM tenant_domains WHERE host = $1 AND status = 'ACTIVE') GROUP BY t.id`, [normalizeHost(host)]);
    if (!rows[0]) throw new TenantNotFoundError(host);
    return toRow(rows[0]);
  }
  async list(opts: { includeDeleted?: boolean } = {}): Promise<TenantRow[]> {
    const { rows } = await this.db.query(`${SELECT} ${opts.includeDeleted ? '' : "WHERE t.status <> 'DELETED'"} GROUP BY t.id ORDER BY t.created_at`);
    return rows.map(toRow);
  }
}
