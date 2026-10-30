import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { RequireFeature, RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { AdminAudited, CONTROL_DB, DomainError, isDev, notFound, parse } from '@mc/nest-common';
import { TenantContext } from '@mc/tenancy';
import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type pg from 'pg';
import { z } from 'zod';

const Host = z.string().trim().toLowerCase().regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/, 'a domain like care.myhospital.in');
const base = () => process.env.TENANT_BASE_DOMAIN ?? 'localhost';

/**
 * Custom domains (Enterprise, feature core.custom_domain): the hospital adds e.g. care.myhospital.in, proves it owns it
 * with a DNS TXT record, and from then on that domain serves the hospital (and its logins). Local dev: *.localhost
 * names have no DNS, so they are accepted without the TXT check.
 */
@Controller('v1/domains')
@RequireModule('core')
@AdminAudited('DOMAIN')
@RequirePermission('settings:manage:tenant')
export class DomainsController {
  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool) {}

  @Get()
  async list() {
    const t = TenantContext.require();
    const { rows } = await this.db.query('SELECT host, is_primary, status, verify_token, created_at, verified_at FROM tenant_domains WHERE tenant_id = $1 ORDER BY is_primary DESC, host', [t.id]);
    return rows.map((r) => ({
      host: r.host, primary: r.is_primary, status: r.status, createdAt: r.created_at, verifiedAt: r.verified_at,
      custom: !r.host.endsWith(`.${base()}`) || !r.is_primary,
      dns: r.status === 'PENDING' ? { type: 'TXT', name: `_medicare-verify.${r.host}`, value: `medicare-verify=${r.verify_token}`, cname: { name: r.host, target: `${t.slug}.${base()}` } } : null,
    }));
  }

  @Post()
  @RequireFeature('core.custom_domain')
  async add(@Body() body: unknown) {
    const t = TenantContext.require();
    const host = parse(z.object({ host: Host }), body).host;
    if (host.endsWith(`.${base()}`) && !isDev()) throw new DomainError(422, 'RESERVED_DOMAIN', `${base()} addresses are given by MediCare`);
    if (host === `${t.slug}.${base()}`) throw new DomainError(409, 'DOMAIN_EXISTS', 'that is already your address');
    const { rows: [n] } = await this.db.query(`SELECT count(*)::int n FROM tenant_domains WHERE tenant_id = $1 AND NOT is_primary`, [t.id]);
    if (n.n >= 5) throw new DomainError(422, 'TOO_MANY_DOMAINS', 'at most 5 custom domains');
    const token = randomBytes(12).toString('hex');
    const { rowCount } = await this.db.query(`INSERT INTO tenant_domains (host, tenant_id, is_primary, status, verify_token) VALUES ($1,$2,false,'PENDING',$3) ON CONFLICT (host) DO NOTHING`, [host, t.id, token]);
    if (!rowCount) throw new DomainError(409, 'DOMAIN_EXISTS', `${host} is already in use`);
    return (await this.list()).find((d) => d.host === host);
  }

  /** Check the TXT record; when it matches, the domain serves this hospital and logins may come back to it. */
  @Post(':host/verify')
  @RequireFeature('core.custom_domain')
  @HttpCode(200)
  async verify(@Param('host') hostParam: string) {
    const t = TenantContext.require();
    const host = Host.safeParse(hostParam);
    if (!host.success) throw notFound('domain');
    const { rows: [d] } = await this.db.query('SELECT host, status, verify_token FROM tenant_domains WHERE host = $1 AND tenant_id = $2', [host.data, t.id]);
    if (!d) throw notFound('domain');
    if (d.status === 'PENDING') {
      const devName = isDev() && d.host.endsWith('.localhost');
      const records = devName ? [] : (await resolveTxt(`_medicare-verify.${d.host}`).catch(() => [])).map((r) => r.join(''));
      if (!devName && !records.includes(`medicare-verify=${d.verify_token}`)) {
        throw new DomainError(422, 'DNS_NOT_VERIFIED', `the TXT record _medicare-verify.${d.host} = medicare-verify=${d.verify_token} was not found yet (DNS can take a while)`);
      }
      const res = await fetch(`${process.env.SVC_URL_IAM ?? 'http://localhost:4402'}/internal/tenants/${t.id}/staff/web-hosts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, body: JSON.stringify({ host: d.host }) });
      if (!res.ok) throw new DomainError(503, 'LOGIN_SETUP_FAILED', 'could not register the domain for sign-in; try again');
      await this.db.query(`UPDATE tenant_domains SET status = 'ACTIVE', verified_at = now() WHERE host = $1`, [d.host]);
    }
    return (await this.list()).find((x) => x.host === d.host);
  }

  @Delete(':host')
  @HttpCode(204)
  async remove(@Param('host') hostParam: string) {
    const t = TenantContext.require();
    const host = Host.safeParse(hostParam);
    if (!host.success) throw notFound('domain');
    const { rowCount } = await this.db.query('DELETE FROM tenant_domains WHERE host = $1 AND tenant_id = $2 AND NOT is_primary', [host.data, t.id]);
    if (!rowCount) throw notFound('domain');
  }
}

/** The setup guide's state: which first steps are done (read from the data), and the owner's "finished". */
@Controller('v1/setup')
@RequireModule('core')
@AdminAudited('SETUP')
@RequirePermission('settings:manage:tenant')
export class SetupController {
  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool) {}

  @Get()
  async get() {
    const t = TenantContext.require();
    const { rows: [r] } = await this.db.query('SELECT name, source, setup_completed_at, branding FROM tenants WHERE id = $1', [t.id]);
    return { name: r.name, source: r.source, completedAt: r.setup_completed_at, brandingSet: !!r.branding?.setupBranding };
  }

  @Post('complete')
  @HttpCode(200)
  async complete() {
    await this.db.query('UPDATE tenants SET setup_completed_at = coalesce(setup_completed_at, now()) WHERE id = $1', [TenantContext.require().id]);
    return this.get();
  }
}
