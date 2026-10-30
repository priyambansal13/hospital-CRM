import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventTypes, type StaffJoined, type TenantPlacement, type TenantProvisioned, Topics } from '@mc/contracts';
import { conflict, CONTROL_DB, DomainError, isDev, notFound, recordAdminAction } from '@mc/nest-common';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, type TenantDbRouter } from '@mc/tenancy';
import type pg from 'pg';
import { KeycloakAdmin } from '../keycloak/keycloak-admin.js';

@Injectable()
export class StaffService {
  private readonly log = new Logger('Staff');
  constructor(private readonly kc: KeycloakAdmin, @Inject(CONTROL_DB) private readonly control: pg.Pool) {}

  /** tenant.provisioned → Keycloak organization, login redirect for the hospital's hosts, first admin. */
  /** A verified custom domain: Keycloak may redirect logins back to it. */
  async allowHost(host: string) {
    const tpl = process.env.PUBLIC_WEB_URL ?? `http://{host}:${process.env.WEB_PORT ?? '3400'}`;
    await this.kc.allowWebHost(tpl.replace('{host}', host));
  }

  async onTenantProvisioned(evt: TenantProvisioned, tenantDb: Queryable) {
    await this.kc.ensureOrganization(evt.slug, evt.name);
    // same origin pattern the notifications use for links: https://{host} in staging/production
    const tpl = process.env.PUBLIC_WEB_URL ?? `http://{host}:${process.env.WEB_PORT ?? '3400'}`;
    for (const h of evt.hosts) await this.kc.allowWebHost(tpl.replace('{host}', h));
    await this.onboard({ id: evt.tenantId, slug: evt.slug }, tenantDb, { email: evt.adminEmail, name: evt.adminName ?? 'Hospital Admin', roles: ['TENANT_ADMIN'] });
  }

  /** Create or reuse the Keycloak account, add it to the hospital's organization, record membership, announce. */
  async onboard(tenant: Pick<TenantPlacement, 'id' | 'slug'>, tenantDb: Queryable, input: { email: string; name: string; roles: string[]; invitedBy?: string; branchId?: string | null }) {
    const t0 = Date.now();
    const org = await this.kc.ensureOrganization(tenant.slug, tenant.slug);
    const t1 = Date.now();
    const { user, created } = await this.kc.ensureStaffUser(input.email.toLowerCase(), input.name);
    const t2 = Date.now();
    await this.kc.addMember(org.id, user.id);
    const t3 = Date.now();

    await this.control.query(
      `INSERT INTO staff_users (id, email, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [user.id, input.email.toLowerCase(), input.name],
    );
    // invited again after being deactivated: back in (the Keycloak account is switched on again)
    await this.control.query(
      `INSERT INTO staff_memberships (user_id, tenant_id) VALUES ($1,$2) ON CONFLICT (user_id, tenant_id) DO UPDATE SET status = 'ACTIVE'`,
      [user.id, tenant.id],
    );
    if (!created) await this.kc.setEnabled(user.id, true);
    const status = isDev() ? 'ACTIVE' : 'INVITED';
    await tenantDb.query(
      `INSERT INTO staff_members (user_id, email, name, status, invited_by, invite_sent_at) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name,
         status = CASE WHEN staff_members.status = 'DISABLED' THEN 'ACTIVE' ELSE staff_members.status END,
         disabled_at = NULL, disabled_by = NULL, disabled_reason = NULL`,
      [user.id, input.email.toLowerCase(), input.name, status, input.invitedBy ?? null],
    );
    const data: StaffJoined = { userId: user.id, email: input.email.toLowerCase(), name: input.name, initialRoles: input.roles, branchId: input.branchId ?? null };
    await addToOutbox(tenantDb, Topics.iam, user.id, envelope(EventTypes.staffJoined, data, { tenantId: tenant.id, subject: user.id }));
    this.log.log(`${input.email} joined ${tenant.slug} as ${input.roles.join(',')} (keycloak: org ${t1 - t0} ms, user ${t2 - t1} ms, member ${t3 - t2} ms; db ${Date.now() - t3} ms)`);
    return { userId: user.id, email: data.email, name: input.name, status, roles: input.roles };
  }

  // ---------- lifecycle (docs/ROLE-FLOWS-AND-GAPS.md B-2) ----------

  /** entitlement-service decides whether the caller may manage this person (no locking out someone with more power). */
  private async entitlements(path: string, actorId: string) {
    const t = TenantContext.require();
    const res = await fetch(`${process.env.SVC_URL_ENTITLEMENT ?? 'http://localhost:4403'}/internal/tenants/${t.id}/users/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' },
      body: JSON.stringify({ actorId }), signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res) throw new DomainError(503, 'ENTITLEMENTS_UNAVAILABLE', 'could not check permissions; try again');
    const body = (await res.json().catch(() => ({}))) as { code?: string; detail?: string; message?: string };
    if (!res.ok) throw new DomainError(res.status === 404 ? 404 : res.status === 403 ? 403 : 422, body.code ?? 'NOT_ALLOWED', body.detail ?? body.message ?? 'not allowed');
    return body;
  }

  private async member(db: Pick<TenantDbRouter, 'query'>, userId: string) {
    const { rows: [m] } = await db.query('SELECT * FROM staff_members WHERE user_id = $1', [userId]);
    if (!m) throw notFound('staff member');
    return m;
  }

  /**
   * Offboarding: roles removed (immediate: every service drops cached permissions), out of the hospital's Keycloak
   * organization (new tokens no longer carry it), sessions ended, and the login disabled unless the person still
   * works at another hospital. Access tokens already issued expire within minutes and carry no permissions here.
   */
  async deactivate(db: TenantDbRouter, actor: Actor, userId: string, reason: string) {
    const t = TenantContext.require();
    const m = await this.member(db, userId);
    if (m.status === 'DISABLED') throw conflict('ALREADY_DEACTIVATED', `${m.name} is already deactivated`);
    await this.entitlements(`${userId}/revoke-all`, actor.id);
    const org = await this.kc.ensureOrganization(t.slug, t.slug);
    await this.kc.removeMember(org.id, userId);
    await this.control.query(`UPDATE staff_memberships SET status = 'DISABLED' WHERE user_id = $1 AND tenant_id = $2`, [userId, t.id]);
    const { rows: [{ others }] } = await this.control.query(`SELECT count(*)::int AS others FROM staff_memberships WHERE user_id = $1 AND status = 'ACTIVE'`, [userId]);
    if (!others) await this.kc.setEnabled(userId, false);
    await this.kc.logout(userId);
    await db.tx(async (c) => {
      await c.query(`UPDATE staff_members SET status = 'DISABLED', disabled_at = now(), disabled_by = $2, disabled_reason = $3 WHERE user_id = $1`, [userId, actor.id, reason]);
      await recordAdminAction('iam-service', actor, { action: 'UPDATE', resourceType: 'STAFF', resourceId: userId, changes: ['deactivated'] });
    });
    this.log.log(`${m.email} deactivated in ${t.slug}${others ? ' (still works at other hospitals)' : ' (login disabled)'}`);
    return { userId, status: 'DISABLED', loginDisabled: !others };
  }

  /** Back in: the login and the hospital membership come back; roles are given again on the staff page. */
  async reactivate(db: TenantDbRouter, actor: Actor, userId: string) {
    const t = TenantContext.require();
    const m = await this.member(db, userId);
    if (m.status !== 'DISABLED') throw conflict('NOT_DEACTIVATED', `${m.name} is not deactivated`);
    if (actor.id === userId) throw new DomainError(422, 'OWN_ACCOUNT', 'you cannot do this to your own account');
    const org = await this.kc.ensureOrganization(t.slug, t.slug);
    await this.kc.setEnabled(userId, true);
    await this.kc.addMember(org.id, userId);
    await this.control.query(`UPDATE staff_memberships SET status = 'ACTIVE' WHERE user_id = $1 AND tenant_id = $2`, [userId, t.id]);
    await db.tx(async (c) => {
      await c.query(`UPDATE staff_members SET status = 'ACTIVE', disabled_at = NULL, disabled_by = NULL, disabled_reason = NULL WHERE user_id = $1`, [userId]);
      await recordAdminAction('iam-service', actor, { action: 'UPDATE', resourceType: 'STAFF', resourceId: userId, changes: ['reactivated'] });
    });
    return { userId, status: 'ACTIVE' };
  }

  /** The invite e-mail again (lost, expired after 3 days): set a password, set up the authenticator app, verify the e-mail. */
  async resendInvite(db: TenantDbRouter, actor: Actor, userId: string) {
    const m = await this.member(db, userId);
    if (m.status !== 'INVITED') throw conflict('ALREADY_SIGNED_IN', m.status === 'DISABLED' ? `${m.name} is deactivated` : `${m.name} has already signed in; reset their password instead`);
    await this.entitlements(`${userId}/manage-check`, actor.id);
    const { rows: [recent] } = await db.query(`SELECT 1 FROM staff_members WHERE user_id = $1 AND invite_sent_at > now() - interval '2 minutes'`, [userId]);
    if (recent) throw new DomainError(429, 'TOO_SOON', 'the invite was sent a moment ago; wait a couple of minutes');
    await this.kc.executeActions(userId, ['UPDATE_PASSWORD', 'CONFIGURE_TOTP', 'VERIFY_EMAIL']);
    await db.tx(async (c) => {
      await c.query('UPDATE staff_members SET invite_sent_at = now() WHERE user_id = $1', [userId]);
      await recordAdminAction('iam-service', actor, { action: 'UPDATE', resourceType: 'STAFF', resourceId: userId, changes: ['invite_resent'] });
    });
    return { sent: true, email: m.email };
  }

  /**
   * Forgotten password or lost phone: the person gets an e-mail to set a new password and/or set up the authenticator
   * app again; their sessions end now. The admin never sees or sets the password.
   */
  async resetSignIn(db: TenantDbRouter, actor: Actor, userId: string, what: { password: boolean; authenticator: boolean }) {
    const m = await this.member(db, userId);
    if (m.status === 'DISABLED') throw conflict('DEACTIVATED', `${m.name} is deactivated; reactivate them first`);
    if (!what.password && !what.authenticator) throw new DomainError(422, 'NOTHING_TO_RESET', 'choose the password, the authenticator app, or both');
    await this.entitlements(`${userId}/manage-check`, actor.id);
    const actions = [...(what.password ? ['UPDATE_PASSWORD'] : []), ...(what.authenticator ? ['CONFIGURE_TOTP'] : [])];
    if (what.authenticator) await this.kc.removeOtp(userId);
    await this.kc.logout(userId);
    await this.kc.executeActions(userId, actions);
    await recordAdminAction('iam-service', actor, { action: 'UPDATE', resourceType: 'STAFF', resourceId: userId, changes: [...(what.password ? ['password_reset'] : []), ...(what.authenticator ? ['authenticator_reset'] : [])] });
    return { sent: true, email: m.email, reset: actions };
  }
}
