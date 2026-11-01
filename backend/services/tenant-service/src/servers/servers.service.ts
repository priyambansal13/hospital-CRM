import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EventTypes, Topics } from '@mc/contracts';
import { CONTROL_DB, DomainError, retryInBackground } from '@mc/nest-common';
import { addToOutbox, envelope, serviceDbConfig, survive, withTx } from '@mc/tenancy';
import pg from 'pg';

export interface DbServer {
  id: string; region: string; kind: 'SHARED' | 'DEDICATED'; status: 'OPEN' | 'CLOSED';
  pooledHost: string; pooledPort: number; directHost: string; directPort: number; peerHost: string; peerPort: number;
  capacity: number; maintenanceWindow: string | null; tenants?: number;
}

const toServer = (r: any): DbServer => ({
  id: r.id, region: r.region, kind: r.kind, status: r.status, pooledHost: r.pooled_host, pooledPort: r.pooled_port,
  directHost: r.direct_host, directPort: r.direct_port, peerHost: r.peer_host, peerPort: r.peer_port,
  capacity: r.capacity, maintenanceWindow: r.maintenance_window, ...(r.tenants != null ? { tenants: Number(r.tenants) } : {}),
});

/**
 * The Postgres servers hospitals live on (docs/MULTI-TENANCY.md §3.5). The first server is registered from this
 * service's own settings on start; others are added by `mc server add` (or Terraform in production).
 */
@Injectable()
export class ServersService implements OnApplicationBootstrap {
  private readonly log = new Logger('Servers');
  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool) {}

  onApplicationBootstrap() {
    retryInBackground('FirstDbServer', () => this.ensureFirst());
  }

  /** The control-plane server also holds hospitals: register it once, and place older hospitals on it. */
  async ensureFirst() {
    const id = process.env.DB_SERVER_ID ?? 'pg-1';
    await this.db.query(`INSERT INTO db_servers (id, pooled_host, pooled_port, direct_host, direct_port, peer_host, peer_port)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, [id,
      process.env.PG_HOST ?? 'localhost', Number(process.env.PG_PORT ?? 61432),
      process.env.PG_HOST_DIRECT ?? process.env.PG_HOST ?? 'localhost', Number(process.env.PG_PORT_DIRECT ?? process.env.PG_PORT ?? 61432),
      process.env.PG_PEER_HOST ?? 'postgres', Number(process.env.PG_PEER_PORT ?? 5432)]);
    const { rowCount } = await this.db.query('UPDATE tenants SET db_server = $1 WHERE db_server IS NULL', [id]);
    if (rowCount) this.log.log(`${rowCount} hospital(s) placed on ${id}`);
  }

  async list(): Promise<DbServer[]> {
    const { rows } = await this.db.query(`SELECT s.*, (SELECT count(*) FROM tenants t WHERE t.db_server = s.id AND t.purged_at IS NULL) tenants FROM db_servers s ORDER BY s.created_at, s.id`);
    return rows.map(toServer);
  }

  async get(id: string): Promise<DbServer> {
    const { rows } = await this.db.query('SELECT * FROM db_servers WHERE id = $1', [id]);
    if (!rows[0]) throw new DomainError(404, 'UNKNOWN_SERVER', `no database server ${id}`);
    return toServer(rows[0]);
  }

  async upsert(s: Omit<DbServer, 'tenants'>) {
    await this.db.query(`INSERT INTO db_servers (id, region, kind, status, pooled_host, pooled_port, direct_host, direct_port, peer_host, peer_port, capacity, maintenance_window)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET region = EXCLUDED.region, kind = EXCLUDED.kind, status = EXCLUDED.status, pooled_host = EXCLUDED.pooled_host,
        pooled_port = EXCLUDED.pooled_port, direct_host = EXCLUDED.direct_host, direct_port = EXCLUDED.direct_port, peer_host = EXCLUDED.peer_host,
        peer_port = EXCLUDED.peer_port, capacity = EXCLUDED.capacity, maintenance_window = EXCLUDED.maintenance_window`,
    [s.id, s.region, s.kind, s.status, s.pooledHost, s.pooledPort, s.directHost, s.directPort, s.peerHost, s.peerPort, s.capacity, s.maintenanceWindow]);
    return this.get(s.id);
  }

  /** Where a new hospital goes: the named server, else the least full open SHARED server in the region. */
  async pick(serverId?: string, region = 'in-1'): Promise<DbServer> {
    if (serverId) {
      const s = await this.get(serverId);
      if (s.status !== 'OPEN') throw new DomainError(409, 'SERVER_CLOSED', `server ${serverId} takes no new hospitals`);
      return s;
    }
    const { rows } = await this.db.query(`SELECT s.*, count(t.id) tenants FROM db_servers s LEFT JOIN tenants t ON t.db_server = s.id AND t.purged_at IS NULL
      WHERE s.kind = 'SHARED' AND s.status = 'OPEN' AND s.region = $1 GROUP BY s.id HAVING count(t.id) < s.capacity ORDER BY count(t.id), s.created_at LIMIT 1`, [region]);
    if (!rows[0]) {
      await this.ensureFirst();
      const first = await this.list();
      if (!first.length) throw new DomainError(503, 'NO_SERVER', 'no database server has room for a new hospital');
      return first[0];
    }
    return toServer(rows[0]);
  }

  /** A short admin connection to a server (as tenant-service's role, which may create databases). */
  async admin<T>(s: DbServer, database: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const cfg = serviceDbConfig('tenant');
    const c = new pg.Client({ host: s.directHost, port: s.directPort, database, user: cfg.user, password: cfg.password, application_name: 'tenant-service:admin' });
    survive(c, `admin:${s.id}`);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  /** The last step of a move: the catalog points at the new server; every service drops its pool on the event. */
  async setPlacement(tenantId: string, serverId: string) {
    const s = await this.get(serverId);
    await withTx(this.db, async (c) => {
      const { rows } = await c.query(`UPDATE tenants SET db_server = $2, db_host = $3, db_port = $4, updated_at = now() WHERE id = $1 AND purged_at IS NULL RETURNING slug, status`,
        [tenantId, s.id, s.pooledHost, s.pooledPort]);
      if (!rows[0]) throw new DomainError(404, 'NOT_FOUND', 'tenant not found');
      await addToOutbox(c, Topics.tenant, tenantId, envelope(EventTypes.tenantUpdated, { tenantId, slug: rows[0].slug, status: rows[0].status, server: s.id }, { tenantId, subject: tenantId }));
    });
  }

  async setRing(tenantId: string, ring: number) {
    const { rowCount } = await this.db.query('UPDATE tenants SET ring = $2, updated_at = now() WHERE id = $1', [tenantId, ring]);
    if (!rowCount) throw new DomainError(404, 'NOT_FOUND', 'tenant not found');
  }

  /**
   * What the migration orchestrator works through (§3.4): every server's template first, then hospitals ring by
   * ring, each with the server to connect to directly.
   */
  async migrationPlan() {
    const servers = await this.list();
    const { rows } = await this.db.query(`SELECT t.id, t.slug, t.db_name, t.status, t.ring, t.db_server, s.kind FROM tenants t JOIN db_servers s ON s.id = t.db_server
      WHERE (t.status IN ('ACTIVE','READ_ONLY') OR (t.status = 'PROVISIONING' AND EXISTS (SELECT 1 FROM provisioning_steps p WHERE p.tenant_id = t.id AND p.step = 'create_database' AND p.status = 'DONE')))
        AND t.purged_at IS NULL ORDER BY t.ring, t.created_at`);
    return {
      servers: servers.map(({ id, kind, directHost, directPort, maintenanceWindow }) => ({ id, kind, directHost, directPort, maintenanceWindow })),
      tenants: rows.map((r) => ({ id: r.id, slug: r.slug, dbName: r.db_name, status: r.status, ring: r.kind === 'DEDICATED' ? 3 : r.ring, server: r.db_server })),
    };
  }
}
