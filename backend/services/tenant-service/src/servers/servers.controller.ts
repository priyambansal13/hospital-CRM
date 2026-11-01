import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { CONTROL_DB, DomainError, Internal, notFound, parse } from '@mc/nest-common';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { ServersService } from './servers.service.js';

const Server = z.object({
  region: z.string().regex(/^[a-z0-9-]{2,20}$/).default('in-1'),
  kind: z.enum(['SHARED', 'DEDICATED']).default('SHARED'),
  status: z.enum(['OPEN', 'CLOSED']).default('OPEN'),
  pooledHost: z.string().min(1).max(200), pooledPort: z.number().int().min(1).max(65535),
  directHost: z.string().min(1).max(200), directPort: z.number().int().min(1).max(65535),
  peerHost: z.string().min(1).max(200), peerPort: z.number().int().min(1).max(65535),
  capacity: z.number().int().min(1).max(100_000).default(500),
  maintenanceWindow: z.string().max(80).nullable().default(null),
});
const Move = z.object({ from: z.string(), to: z.string() });
const MoveStep = z.object({ step: z.string().max(60), status: z.enum(['RUNNING', 'DONE', 'FAILED']).optional(), detail: z.record(z.string(), z.unknown()).optional(), readOnlyMs: z.number().int().min(0).optional() });
const Backup = z.object({
  id: z.uuid(), serverId: z.string(), kind: z.enum(['NIGHTLY', 'MANUAL', 'PRE_MOVE']), location: z.string().max(500), bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), tables: z.record(z.string(), z.number().int()), versions: z.record(z.string(), z.string()),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
});
const Drill = z.object({ ok: z.boolean(), seconds: z.number().min(0), report: z.record(z.string(), z.unknown()) });
const uuid = (id: string) => { if (!z.uuid().safeParse(id).success) throw notFound('tenant'); return id; };

/**
 * Operations on the database layer (Phase 30), used by the platform CLI and the in-cluster jobs: servers,
 * migration plan, moves between servers, release rings, backups and restore drills.
 */
@Controller('internal')
export class InternalServersController {
  constructor(private readonly servers: ServersService, @Inject(CONTROL_DB) private readonly db: pg.Pool) {}

  @Get('db-servers')
  @Internal()
  list() {
    return this.servers.list();
  }

  @Put('db-servers/:id')
  @Internal()
  upsert(@Param('id') id: string, @Body() body: unknown) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new DomainError(400, 'BAD_SERVER_ID', 'lowercase letters, digits and dashes');
    return this.servers.upsert({ id, ...parse(Server, body) });
  }

  @Get('migration-plan')
  @Internal()
  plan() {
    return this.servers.migrationPlan();
  }

  @Put('tenants/:id/placement')
  @Internal()
  async placement(@Param('id') id: string, @Body() body: unknown) {
    const { server } = parse(z.object({ server: z.string() }), body);
    await this.servers.setPlacement(uuid(id), server);
    return { tenantId: id, server };
  }

  @Put('tenants/:id/ring')
  @Internal()
  async ring(@Param('id') id: string, @Body() body: unknown) {
    const { ring } = parse(z.object({ ring: z.number().int().min(0).max(3) }), body);
    await this.servers.setRing(uuid(id), ring);
    return { tenantId: id, ring };
  }

  // ---- moves (the CLI / move Job records each step here)
  @Post('tenants/:id/moves')
  @Internal()
  async startMove(@Param('id') id: string, @Body() body: unknown) {
    const m = parse(Move, body);
    const { rows: running } = await this.db.query(`SELECT id FROM tenant_moves WHERE tenant_id = $1 AND status = 'RUNNING' AND started_at > now() - interval '2 hours'`, [uuid(id)]);
    if (running[0]) throw new DomainError(409, 'MOVE_RUNNING', `a move of this hospital is already running (${running[0].id})`);
    const moveId = randomUUID();
    await this.db.query(`INSERT INTO tenant_moves (id, tenant_id, from_server, to_server, status, step) VALUES ($1,$2,$3,$4,'RUNNING','start')`, [moveId, id, m.from, m.to]);
    return { id: moveId };
  }

  @Patch('moves/:id')
  @Internal()
  async moveStep(@Param('id') id: string, @Body() body: unknown) {
    const s = parse(MoveStep, body);
    const { rowCount } = await this.db.query(`UPDATE tenant_moves SET step = $2, status = coalesce($3, status), detail = detail || $4::jsonb, read_only_ms = coalesce($5, read_only_ms),
      finished_at = CASE WHEN $3 IN ('DONE','FAILED') THEN now() ELSE finished_at END WHERE id = $1`, [uuid(id), s.step, s.status ?? null, JSON.stringify(s.detail ?? {}), s.readOnlyMs ?? null]);
    if (!rowCount) throw notFound('move');
    return { id, ...s };
  }

  @Get('tenants/:id/moves')
  @Internal()
  async moves(@Param('id') id: string) {
    const { rows } = await this.db.query('SELECT * FROM tenant_moves WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 20', [uuid(id)]);
    return rows;
  }

  // ---- backups
  @Get('tenants/:id/backup-key')
  @Internal()
  async backupKey(@Param('id') id: string) {
    const { rows } = await this.db.query('SELECT wrapped FROM tenant_backup_keys WHERE tenant_id = $1', [uuid(id)]);
    if (!rows[0]) throw notFound('backup key');
    return { wrapped: rows[0].wrapped };
  }

  /** First backup of a hospital: store its (wrapped) key; an existing key is never replaced. */
  @Put('tenants/:id/backup-key')
  @Internal()
  async putBackupKey(@Param('id') id: string, @Body() body: unknown) {
    const { wrapped } = parse(z.object({ wrapped: z.string().min(20).max(1000) }), body);
    await this.db.query('INSERT INTO tenant_backup_keys (tenant_id, wrapped) VALUES ($1,$2) ON CONFLICT (tenant_id) DO NOTHING', [uuid(id), wrapped]);
    return this.backupKey(id);
  }

  @Post('tenants/:id/backups')
  @Internal()
  async recordBackup(@Param('id') id: string, @Body() body: unknown) {
    const b = parse(Backup, body);
    await this.db.query(`INSERT INTO tenant_backups (id, tenant_id, server_id, kind, location, bytes, sha256, tables, versions, started_at, finished_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [b.id, uuid(id), b.serverId, b.kind, b.location, b.bytes, b.sha256, b.tables, b.versions, b.startedAt, b.finishedAt]);
    return { id: b.id };
  }

  @Get('tenants/:id/backups')
  @Internal()
  async backups(@Param('id') id: string) {
    const { rows } = await this.db.query('SELECT * FROM tenant_backups WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 60', [uuid(id)]);
    return rows;
  }

  @Patch('backups/:id/drill')
  @Internal()
  @HttpCode(200)
  async drill(@Param('id') id: string, @Body() body: unknown) {
    const d = parse(Drill, body);
    const { rowCount } = await this.db.query('UPDATE tenant_backups SET drill_at = now(), drill_ok = $2, drill_seconds = $3, drill_report = $4 WHERE id = $1', [uuid(id), d.ok, d.seconds, d.report]);
    if (!rowCount) throw notFound('backup');
    return { id, ...d };
  }

  /** Each hospital's latest backup and drill (for the console and the backup-age alert). */
  @Get('backups/summary')
  @Internal()
  async summary() {
    const { rows } = await this.db.query(`SELECT t.id tenant_id, t.slug, t.db_server, b.id backup_id, b.started_at, b.bytes, d.drill_at, d.drill_ok, d.drill_seconds
      FROM tenants t
      LEFT JOIN LATERAL (SELECT * FROM tenant_backups x WHERE x.tenant_id = t.id ORDER BY started_at DESC LIMIT 1) b ON true
      LEFT JOIN LATERAL (SELECT * FROM tenant_backups x WHERE x.tenant_id = t.id AND drill_at IS NOT NULL ORDER BY drill_at DESC LIMIT 1) d ON true
      WHERE t.status IN ('ACTIVE','READ_ONLY') AND t.purged_at IS NULL ORDER BY t.slug`);
    return rows;
  }
}
