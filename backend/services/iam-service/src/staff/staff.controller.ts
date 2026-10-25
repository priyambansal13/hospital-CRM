import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { CONTROL_DB, CurrentActor, DomainError, Idempotent, PLACEMENTS, parse } from '@mc/nest-common';
import { RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import type pg from 'pg';
import { z } from 'zod';
import { StaffService } from './staff.service.js';

const Invite = z.object({
  email: z.email(),
  name: z.string().trim().min(2).max(120),
  roles: z.array(z.string().regex(/^[A-Z_]{3,40}$/)).min(1).max(10),
});

@Controller('v1')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly db: TenantDbRouter,
    @Inject(CONTROL_DB) private readonly control: pg.Pool,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource,
  ) {}

  /** Who am I, in this hospital (and which other hospitals I can switch to). */
  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    const t = TenantContext.require();
    const tenant = { id: t.id, slug: t.slug, name: t.name };
    if (actor.kind === 'patient') {
      const { rows } = await this.db.query('SELECT phone FROM patient_accounts WHERE person_id = $1', [actor.id]);
      return { kind: 'patient', id: actor.id, phone: rows[0]?.phone ?? null, tenant };
    }
    const { rows } = await this.db.query('SELECT email, name, status FROM staff_members WHERE user_id = $1', [actor.id]);
    const { rows: ms } = await this.control.query('SELECT tenant_id FROM staff_memberships WHERE user_id = $1 AND status = $2', [actor.id, 'ACTIVE']);
    const all = await this.placements.list();
    const memberships = all.filter((p) => ms.some((m) => m.tenant_id === p.id)).map((p) => ({ tenantId: p.id, slug: p.slug, name: p.name, hosts: p.hosts }));
    return { kind: 'staff', id: actor.id, email: rows[0]?.email ?? actor.email, name: rows[0]?.name ?? null, status: rows[0]?.status ?? null, tenant, memberships };
  }

  /**
   * Called by the web app right after a staff sign-in: an invited member who has signed in (password and MFA set
   * up in Keycloak) is now ACTIVE in this hospital (review A-3: nothing else ever moved them on).
   */
  @Post('me/signed-in')
  @HttpCode(200)
  async signedIn(@CurrentActor() actor: Actor) {
    if (actor.kind !== 'staff') return { status: null };
    const { rows } = await this.db.query(`UPDATE staff_members SET status = 'ACTIVE' WHERE user_id = $1 AND status = 'INVITED' RETURNING status`, [actor.id]);
    if (rows[0]) return { status: 'ACTIVE', activated: true };
    const { rows: [m] } = await this.db.query('SELECT status FROM staff_members WHERE user_id = $1', [actor.id]);
    return { status: m?.status ?? null, activated: false };
  }

  @Get('staff')
  @RequirePermission('staff:read:tenant')
  async list() {
    const { rows } = await this.db.query('SELECT user_id, email, name, status, created_at FROM staff_members ORDER BY name');
    return rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.name, status: r.status, createdAt: r.created_at }));
  }

  @Post('staff/invites')
  @Idempotent()
  @RequirePermission('staff:invite:tenant')
  async invite(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const input = parse(Invite, body);
    const t = TenantContext.require();
    // before any login is created: the roles exist and the inviter may give them (no escalation; review B-3)
    const res = await fetch(`${process.env.SVC_URL_ENTITLEMENT ?? 'http://localhost:4403'}/internal/tenants/${t.id}/roles/grant-check`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' },
      body: JSON.stringify({ actorId: actor.id, roles: input.roles }), signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res) throw new DomainError(503, 'ENTITLEMENTS_UNAVAILABLE', 'could not check the roles; try again');
    if (!res.ok) {
      const p = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
      throw new DomainError(res.status === 403 ? 403 : 422, p.code ?? 'ROLE_CHECK_FAILED', p.detail ?? 'these roles cannot be given');
    }
    return this.db.tx((c) => this.staff.onboard(t, c, { ...input, invitedBy: actor.id }));
  }
}
