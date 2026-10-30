import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { EventTypes, Topics } from '@mc/contracts';
import { AdminAudited, conflict, CurrentActor, Idempotent, Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { assertWithinLimit, EntitlementsClient, RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, addToOutbox, envelope, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const BranchFields = {
  name: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(80),
  address: z.object({ line1: z.string().max(200).optional(), pincode: z.string().max(10).optional() }),
  // an IANA zone the runtime knows (slot times and "today" at the branch depend on it), E-4
  timezone: z.string().refine((tz) => tz === 'UTC' || Intl.supportedValuesOf('timeZone').includes(tz), 'a time zone like Asia/Kolkata'),
};
export const CreateBranch = z.object({ ...BranchFields, address: BranchFields.address.default({}), timezone: BranchFields.timezone.default('Asia/Kolkata') });
/** No defaults on update: a PATCH only changes the fields it sends. */
export const UpdateBranch = z.object(BranchFields).partial().extend({ active: z.boolean().optional(), version: z.number().int() });

const toDto = (r: any) => ({ id: r.id, name: r.name, city: r.city, address: r.address, timezone: r.timezone, active: r.active, version: r.version, createdAt: r.created_at });
const UNIQUE_VIOLATION = '23505';

/** Branches live in each hospital's own database (core module). */
@Controller('v1/branches')
@RequireModule('core')
export class BranchesController {
  constructor(private readonly db: TenantDbRouter, private readonly entitlements: EntitlementsClient) {}

  @Get()
  @RequirePermission('branch:read:tenant')
  async list() {
    const { rows } = await this.db.query('SELECT * FROM branches ORDER BY name');
    return rows.map(toDto);
  }

  @Get(':id')
  @RequirePermission('branch:read:tenant')
  async get(@Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('branch');
    const { rows } = await this.db.query('SELECT * FROM branches WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('branch');
    return toDto(rows[0]);
  }

  @Post()
  @Idempotent()
  @AdminAudited('BRANCH')
  @RequirePermission('branch:manage:tenant')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const input = parse(CreateBranch, body);
    const tenantId = TenantContext.require().id;
    const caps = await this.entitlements.capabilities(tenantId, actor);
    try {
      return await this.db.tx(async (c) => {
        // the plan's branch limit (core.branches); serialised so two parallel requests can't both take the last place
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('branch-limit'))`);
        assertWithinLimit(caps, 'core.branches', Number((await c.query('SELECT count(*) n FROM branches WHERE active')).rows[0].n));
        const { rows } = await c.query(
          'INSERT INTO branches (id, name, city, address, timezone) VALUES ($1,$2,$3,$4,$5) RETURNING *',
          [randomUUID(), input.name, input.city, input.address, input.timezone],
        );
        const b = rows[0];
        await addToOutbox(c, Topics.tenant, b.id, envelope(EventTypes.branchCreated, { branchId: b.id, name: b.name, active: b.active, timezone: b.timezone }, { tenantId, subject: b.id }));
        return toDto(b);
      });
    } catch (e) {
      if ((e as any).code === UNIQUE_VIOLATION) throw conflict('BRANCH_EXISTS', 'a branch with this name already exists');
      throw e;
    }
  }

  @Patch(':id')
  @AdminAudited('BRANCH')
  @RequirePermission('branch:manage:tenant')
  async update(@Param('id') id: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(id).success) throw notFound('branch');
    const input = parse(UpdateBranch, body);
    const tenantId = TenantContext.require().id;
    return this.db.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE branches SET name = coalesce($3, name), city = coalesce($4, city), address = coalesce($5, address),
           timezone = coalesce($6, timezone), active = coalesce($7, active), version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $2 RETURNING *`,
        [id, input.version, input.name ?? null, input.city ?? null, input.address ?? null, input.timezone ?? null, input.active ?? null],
      );
      if (!rows[0]) {
        const exists = await c.query('SELECT 1 FROM branches WHERE id = $1', [id]);
        throw exists.rowCount ? conflict('VERSION_CONFLICT', 'branch was changed by someone else; reload and retry') : notFound('branch');
      }
      const b = rows[0];
      await addToOutbox(c, Topics.tenant, b.id, envelope(EventTypes.branchUpdated, { branchId: b.id, name: b.name, active: b.active, timezone: b.timezone }, { tenantId, subject: b.id }));
      return toDto(b);
    });
  }
}

/** Active branches: per-branch pricing on MediCare's invoice (subscription-service). */
@Controller('internal/tenants/:tenantId/branch-count')
export class InternalBranchCountController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get()
  @Internal()
  async count(@Param('tenantId') tenantId: string) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    return TenantContext.run(await this.placements.get(tenantId), async () => ({ branches: Number((await this.db.query('SELECT count(*) n FROM branches WHERE active')).rows[0].n) }));
  }
}
