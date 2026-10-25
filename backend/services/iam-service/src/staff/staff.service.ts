import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventTypes, type StaffJoined, type TenantPlacement, type TenantProvisioned, Topics } from '@mc/contracts';
import { CONTROL_DB, isDev } from '@mc/nest-common';
import { addToOutbox, envelope, type Queryable } from '@mc/tenancy';
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
  async onboard(tenant: Pick<TenantPlacement, 'id' | 'slug'>, tenantDb: Queryable, input: { email: string; name: string; roles: string[]; invitedBy?: string }) {
    const t0 = Date.now();
    const org = await this.kc.ensureOrganization(tenant.slug, tenant.slug);
    const t1 = Date.now();
    const { user } = await this.kc.ensureStaffUser(input.email.toLowerCase(), input.name);
    const t2 = Date.now();
    await this.kc.addMember(org.id, user.id);
    const t3 = Date.now();

    await this.control.query(
      `INSERT INTO staff_users (id, email, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [user.id, input.email.toLowerCase(), input.name],
    );
    await this.control.query(
      `INSERT INTO staff_memberships (user_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [user.id, tenant.id],
    );
    const status = isDev() ? 'ACTIVE' : 'INVITED';
    await tenantDb.query(
      `INSERT INTO staff_members (user_id, email, name, status, invited_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name`,
      [user.id, input.email.toLowerCase(), input.name, status, input.invitedBy ?? null],
    );
    const data: StaffJoined = { userId: user.id, email: input.email.toLowerCase(), name: input.name, initialRoles: input.roles };
    await addToOutbox(tenantDb, Topics.iam, user.id, envelope(EventTypes.staffJoined, data, { tenantId: tenant.id, subject: user.id }));
    this.log.log(`${input.email} joined ${tenant.slug} as ${input.roles.join(',')} (keycloak: org ${t1 - t0} ms, user ${t2 - t1} ms, member ${t3 - t2} ms; db ${Date.now() - t3} ms)`);
    return { userId: user.id, email: data.email, name: input.name, status, roles: input.roles };
  }
}
