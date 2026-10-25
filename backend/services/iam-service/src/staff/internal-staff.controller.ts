import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { StaffService } from './staff.service.js';

const Onboard = z.object({
  email: z.email(),
  name: z.string().trim().min(2).max(120),
  roles: z.array(z.string().regex(/^[A-Z_]{3,40}$/)).min(1).max(10),
  invitedBy: z.uuid().optional(),
});

/**
 * Service-to-service onboarding: e.g. provider-service adds a doctor after checking doctor:manage itself, and asks
 * iam to create (or reuse) the login. Idempotent per email. Not reachable through the gateway.
 */
@Controller('internal/tenants/:tenantId/staff')
export class InternalStaffController {
  constructor(private readonly staff: StaffService, private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  /** tenant-service: a custom domain was verified (logins may come back to it). */
  @Post('web-hosts')
  @Internal()
  async allowHost(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    await this.placements.get(tenantId);
    await this.staff.allowHost(parse(z.object({ host: z.string().regex(/^[a-z0-9.-]{3,253}$/) }), body).host);
    return { ok: true };
  }

  /** Is this e-mail a staff member here (signup readiness: the owner's login exists)? */
  @Get()
  @Internal()
  async byEmail(@Param('tenantId') tenantId: string, @Query('email') email: string) {
    if (!z.uuid().safeParse(tenantId).success || !z.email().safeParse(email).success) throw notFound('staff member');
    return TenantContext.run(await this.placements.get(tenantId), async () => {
      const { rows } = await this.db.query('SELECT user_id, email, name, status FROM staff_members WHERE email = $1', [email.toLowerCase()]);
      if (!rows[0]) throw notFound('staff member');
      // reachable unless disabled: an invited member who has not signed in yet still owns the address (review A-3)
      return { userId: rows[0].user_id, email: rows[0].email, name: rows[0].name, status: rows[0].status, active: rows[0].status !== 'DISABLED' };
    });
  }

  /** Contact for a staff member of this hospital (notification-service emails doctors). */
  @Get(':userId')
  @Internal()
  async contact(@Param('tenantId') tenantId: string, @Param('userId') userId: string) {
    if (!z.uuid().safeParse(tenantId).success || !z.uuid().safeParse(userId).success) throw notFound('staff member');
    return TenantContext.run(await this.placements.get(tenantId), async () => {
      const { rows } = await this.db.query('SELECT user_id, email, name, status FROM staff_members WHERE user_id = $1', [userId]);
      if (!rows[0]) throw notFound('staff member');
      // reachable unless disabled: an invited member who has not signed in yet still owns the address (review A-3)
      return { userId: rows[0].user_id, email: rows[0].email, name: rows[0].name, status: rows[0].status, active: rows[0].status !== 'DISABLED' };
    });
  }

  @Post()
  @Internal()
  async onboard(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    const input = parse(Onboard, body);
    const t = await this.placements.get(tenantId);
    return TenantContext.run(t, () => this.db.tx((c) => this.staff.onboard(t, c, input)));
  }
}
