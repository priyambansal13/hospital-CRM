import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { DomainError, Internal, notFound, parse, TenantPublic } from '@mc/nest-common';
import { RequirePermission } from '@mc/entitlements-sdk';
import { TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { CatalogRepo } from './catalog.repo.js';
import { ProvisioningService } from './provisioning.service.js';

const CreateTenant = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/, 'lowercase letters, digits, dashes; 3-31 chars'),
  name: z.string().min(2).max(120),
  adminEmail: z.email(),
  plan: z.string().optional(),
});
const Status = z.object({ status: z.enum(['ACTIVE', 'READ_ONLY', 'SUSPENDED', 'DELETED']) });
const Branding = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.url().nullable().optional(),
});

/** Control-plane API used by the platform CLI/console and by other services (placements, host resolution). */
@Controller('internal')
export class InternalCatalogController {
  constructor(private readonly catalog: CatalogRepo, private readonly provisioning: ProvisioningService) {}

  @Post('tenants')
  @Internal()
  create(@Body() body: unknown) {
    return this.provisioning.create(parse(CreateTenant, body));
  }

  @Get('tenants')
  @Internal()
  list() {
    return this.catalog.list();
  }

  @Get('tenants/:id')
  @Internal()
  async get(@Param('id') id: string) {
    return (await this.catalog.find(id)) ?? Promise.reject(notFound('tenant'));
  }

  @Patch('tenants/:id/status')
  @Internal()
  async status(@Param('id') id: string, @Body() body: unknown) {
    await this.provisioning.setStatus(id, parse(Status, body).status);
    return this.catalog.find(id);
  }

  /** The in-cluster migration Job reports what it applied (same table the local `mc migrate` writes). */
  @Put('tenants/:id/schema-versions/:service')
  @Internal()
  async schemaVersion(@Param('id') id: string, @Param('service') service: string, @Body() body: unknown) {
    const { version } = parse(z.object({ version: z.string().max(100) }), body);
    if (!(await this.catalog.find(id))) throw notFound('tenant');
    if (!/^[a-z_]{2,40}$/.test(service)) throw new DomainError(400, 'BAD_SERVICE', 'bad service name');
    await this.provisioning.recordSchemaVersion(id, service, version);
    return { tenantId: id, service, version };
  }

  @Get('resolve')
  @Internal()
  resolve(@Query('host') host: string) {
    if (!host) throw new DomainError(400, 'HOST_REQUIRED', 'host query parameter required');
    return this.catalog.resolveHost(host);
  }
}

@Controller('v1')
export class BrandingController {
  constructor(private readonly catalog: CatalogRepo, private readonly provisioning: ProvisioningService) {}

  /** Shown on the login page before anyone signs in. */
  @Get('public/branding')
  @TenantPublic()
  async branding() {
    const t = (await this.catalog.find(TenantContext.require().id))!;
    return { tenantId: t.id, slug: t.slug, name: t.name, branding: t.branding };
  }

  @Patch('branding')
  @RequirePermission('settings:manage:tenant')
  async update(@Body() body: unknown) {
    const id = TenantContext.require().id;
    const { name, ...branding } = parse(Branding, body);
    // setupBranding: the setup guide's "branding" step is done once the owner saved it
    await this.provisioning.updateBranding(id, { ...branding, setupBranding: true }, name);
    return this.branding();
  }
}
