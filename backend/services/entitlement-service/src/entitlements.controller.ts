import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentActor, Internal, notFound, parse, PLACEMENTS, TenantPublic } from '@mc/nest-common';
import { RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { ConfigService } from './config.service.js';
import { EntitlementsService } from './entitlements.service.js';

const Uuid = z.uuid();
const RoleCode = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z][A-Z_]{2,39}$/, 'CAPITALS_AND_UNDERSCORES'));
const NewRole = z.object({ code: RoleCode, name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).nullable().default(null), copyFrom: z.string().regex(/^[A-Z_]{3,40}$/).nullable().default(null) });
const RolePermissions = z.object({ permissions: z.array(z.string().regex(/^[a-z_]+:[a-z_]+:[a-z_]+$/)).max(300), name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(300).nullable().optional() });
const SettingValue = z.object({ value: z.union([z.number(), z.string(), z.boolean()]) });
const AssignRole = z.object({ roleCode: z.string().regex(/^[A-Z_]{3,40}$/), branchId: z.uuid().nullable().default(null) });

@Controller('v1')
export class EntitlementsController {
  constructor(private readonly svc: EntitlementsService, private readonly db: TenantDbRouter, private readonly config: ConfigService) {}

  @Get('me/capabilities')
  capabilities(@CurrentActor() actor: Actor) {
    return this.svc.capabilities(actor);
  }

  @Get('modules')
  async modules() {
    const states = await this.svc.moduleStates(await this.db.current());
    return [...this.svc.catalog.modules.values()].map((m) => ({ key: m.key, name: m.name, state: states.get(m.key) ?? 'OFF', active: states.get(m.key) === 'ACTIVE', alwaysOn: m.alwaysOn, dependsOn: m.dependsOn }));
  }

  /** Which modules this hospital offers (signed-out pages hide what isn't there): in full use, and read-only. */
  @Get('public/modules')
  @TenantPublic()
  async publicModules() {
    return this.svc.tenantModules(await this.db.current());
  }

  @Get('roles')
  @RequirePermission('role:read:tenant')
  async roles() {
    const { rows } = await this.db.query(`SELECT r.code, r.name, r.is_system, r.grants_all,
      coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') permissions
      FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.code`);
    return rows.map((r) => ({ code: r.code, name: r.name, isSystem: r.is_system, grantsAll: r.grants_all, permissions: r.permissions }));
  }

  @Get('users/:userId/roles')
  @RequirePermission('role:read:tenant')
  async userRoles(@Param('userId') userId: string) {
    if (!Uuid.safeParse(userId).success) throw notFound('user');
    await this.svc.assertKnownUser(await this.db.current(), userId);
    const { rows } = await this.db.query(`SELECT r.code, ur.branch_id, ur.valid_until FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`, [userId]);
    return rows.map((r) => ({ roleCode: r.code, branchId: r.branch_id, validUntil: r.valid_until }));
  }

  @Post('users/:userId/roles')
  @RequirePermission('role:assign:tenant')
  async assign(@Param('userId') userId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    if (!Uuid.safeParse(userId).success) throw notFound('user');
    const { roleCode, branchId } = parse(AssignRole, body);
    await this.db.tx(async (c) => {
      await this.svc.assertCanGrant(c, actor.id, [roleCode]);
      await this.svc.assignRoles(c, userId, [roleCode], branchId);
    });
    return this.userRoles(userId);
  }

  @Delete('users/:userId/roles/:roleCode')
  @RequirePermission('role:assign:tenant')
  @HttpCode(204)
  async remove(@Param('userId') userId: string, @Param('roleCode') roleCode: string, @CurrentActor() actor: Actor) {
    if (!Uuid.safeParse(userId).success) throw notFound('user');
    await this.db.tx(async (c) => {
      await this.config.assertNotLastOwner(c, userId, roleCode, actor.id);
      await this.svc.removeRole(c, userId, roleCode);
    });
  }

  // ---------- settings (within the plan's bounds) ----------

  @Get('settings')
  @RequirePermission('settings:manage:tenant')
  settings() {
    return this.config.settings();
  }

  @Put('settings/:key')
  @RequirePermission('settings:manage:tenant')
  saveSetting(@Param('key') key: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    if (!/^[a-z_]+\.[a-z_]+$/.test(key)) throw notFound('setting');
    return this.config.saveSetting(key, parse(SettingValue, body).value, actor.email ?? actor.id);
  }

  // ---------- role editor ----------

  @Get('role-editor')
  @RequirePermission('role:read:tenant')
  async roleEditor() {
    return { roles: await this.config.roles(), catalogue: await this.config.catalogue(), customRoles: await this.config.customRolesAllowed(), history: await this.config.history() };
  }

  @Post('roles')
  @RequirePermission('role:manage:tenant')
  createRole(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.config.createRole(parse(NewRole, body), actor.email ?? actor.id, actor.id);
  }

  @Put('roles/:code')
  @RequirePermission('role:manage:tenant')
  setRole(@Param('code') code: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    if (!/^[A-Z_]{3,40}$/.test(code)) throw notFound('role');
    const q = parse(RolePermissions, body);
    return this.config.setPermissions(code, q.permissions, actor.email ?? actor.id, actor.id, { name: q.name, description: q.description });
  }

  @Delete('roles/:code')
  @RequirePermission('role:manage:tenant')
  @HttpCode(204)
  async deleteRole(@Param('code') code: string, @CurrentActor() actor: Actor) {
    if (!/^[A-Z_]{3,40}$/.test(code)) throw notFound('role');
    await this.config.deleteRole(code, actor.email ?? actor.id);
  }

  @Get('roles/:code/preview')
  @RequirePermission('role:read:tenant')
  preview(@Param('code') code: string) {
    if (!/^[A-Z_]{3,40}$/.test(code)) throw notFound('role');
    return this.config.preview(code);
  }
}

/** Used by @mc/entitlements-sdk in every service, and by the platform CLI/console. */
@Controller('internal')
export class InternalEntitlementsController {
  constructor(private readonly svc: EntitlementsService, private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly config: ConfigService) {}

  /** iam asks before inviting: may this staff member give these roles? (review B-3; 422/403 when not) */
  @Post('tenants/:tenantId/roles/grant-check')
  @Internal()
  @HttpCode(200)
  async grantCheck(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    if (!Uuid.safeParse(tenantId).success) throw notFound('tenant');
    const v = parse(z.object({ actorId: z.uuid(), roles: z.array(z.string().min(1).max(40)).min(1).max(10) }), body);
    return TenantContext.run(await this.placements.get(tenantId), async () => {
      await this.svc.assertCanGrant(await this.db.current(), v.actorId, v.roles);
      return { ok: true };
    });
  }

  private async inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    if (!Uuid.safeParse(tenantId).success) throw notFound('tenant');
    return TenantContext.run(await this.placements.get(tenantId), fn);
  }

  @Get('capabilities/:tenantId/:actorId')
  @Internal()
  caps(@Param('tenantId') tenantId: string, @Param('actorId') actorId: string, @Query('kind') kind: string) {
    if (!Uuid.safeParse(actorId).success) throw notFound('actor');
    return this.inTenant(tenantId, () => this.svc.capabilities({ id: actorId, kind: kind === 'patient' ? 'patient' : 'staff' }));
  }

  /** Module states per hospital (SDK guard: ACTIVE = full use, readOnly = GET only). Switching modules: subscription-service. */
  @Get('tenants/:tenantId/modules')
  @Internal()
  modules(@Param('tenantId') tenantId: string) {
    return this.inTenant(tenantId, async () => this.svc.tenantModules(await this.db.current()));
  }

  /** Limits and overage rules (metering in every service), and the subscription status. */
  @Get('tenants/:tenantId/features')
  @Internal()
  features(@Param('tenantId') tenantId: string) {
    return this.inTenant(tenantId, async () => this.svc.tenantFeatures(await this.db.current()));
  }

  /** Staff ids holding a permission (notification-service: who gets billing e-mails). */
  @Get('tenants/:tenantId/users-with-permission/:permission')
  @Internal()
  usersWith(@Param('tenantId') tenantId: string, @Param('permission') permission: string) {
    if (!/^[a-z_]+:[a-z_]+:[a-z_]+$/.test(permission)) throw notFound('permission');
    return this.inTenant(tenantId, async () => ({ userIds: await this.svc.usersWithPermission(await this.db.current(), permission) }));
  }

  /** Effective settings (services read them through the SDK). */
  @Get('tenants/:tenantId/settings')
  @Internal()
  effectiveSettings(@Param('tenantId') tenantId: string) {
    return this.inTenant(tenantId, async () => ({ settings: await this.config.effective() }));
  }

  /** The contract last applied here (the CLI waits for it after a plan change). */
  @Get('tenants/:tenantId/plan')
  @Internal()
  plan(@Param('tenantId') tenantId: string) {
    return this.inTenant(tenantId, async () => (await this.db.query('SELECT contract_id, seq, plan_code, plan_version, applied_at FROM tenant_plan')).rows[0] ?? null);
  }

  /** Support view: every module's state, retries and the last hook error. */
  @Get('tenants/:tenantId/module-states')
  @Internal()
  moduleStates(@Param('tenantId') tenantId: string) {
    return this.inTenant(tenantId, async () => (await this.db.query('SELECT module_key, state, source, since, attempts, last_error FROM tenant_modules ORDER BY module_key')).rows);
  }
}
