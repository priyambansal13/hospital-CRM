import { Body, Controller, Get, Headers, HttpCode, Injectable, Param, Patch, Post, Query, Res, type OnModuleInit } from '@nestjs/common';
import { EventTypes, Topics } from '@mc/contracts';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { ConsumerRegistry, CurrentActor, DomainError, notFound, parse, TenantPublic } from '@mc/nest-common';
import type { Actor } from '@mc/tenancy';
import { z } from 'zod';
import { LisService } from '../fhir/lis.js';
import { outcome } from '../fhir/mappers.js';
import { ApiKeysService, SCOPES } from '../keys/api-keys.service.js';
import { WEBHOOK_EVENTS } from './catalog.js';
import { WebhooksService } from './webhooks.service.js';

const id = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };
const Url = z.string().trim().url().max(500);
const Events = z.array(z.enum(Object.keys(WEBHOOK_EVENTS) as [string])).min(1).max(30);
const NewEndpoint = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('WEBHOOK'), name: z.string().trim().min(1).max(80), url: Url, events: Events }),
  z.object({ kind: z.literal('LIS'), name: z.string().trim().min(1).max(80), url: Url }),
]);
const EndpointPatch = z.object({ name: z.string().trim().min(1).max(80).optional(), url: Url.optional(), events: Events.optional(), active: z.boolean().optional(), rotateSecret: z.boolean().optional(), version: z.number().int() });
const NewKey = z.object({ name: z.string().trim().min(1).max(80), scopes: z.array(z.enum(Object.keys(SCOPES) as [keyof typeof SCOPES])).min(1) });

/** Admin: webhooks, the LIS connection and API keys (Phase 27). */
@Controller('v1/integrations')
@RequireModule('integrations')
@RequirePermission('integration:manage:tenant')
export class IntegrationsController {
  constructor(private readonly hooks: WebhooksService, private readonly keys: ApiKeysService) {}

  @Get('catalog')
  catalog() {
    return { events: Object.entries(WEBHOOK_EVENTS).map(([key, v]) => ({ key, label: v.label })), scopes: Object.entries(SCOPES).map(([key, label]) => ({ key, label })) };
  }

  @Get('endpoints') endpoints(@Query('kind') kind?: string) { return this.hooks.list(kind === 'LIS' ? 'LIS' : 'WEBHOOK'); }
  @Post('endpoints') create(@Body() body: unknown) { return this.hooks.create(parse(NewEndpoint, body)); }
  @Patch('endpoints/:id') update(@Param('id') p: string, @Body() body: unknown) { return this.hooks.update(id(p, 'endpoint'), parse(EndpointPatch, body)); }
  @Post('endpoints/:id/test') @HttpCode(200) test(@Param('id') p: string) { return this.hooks.test(id(p, 'endpoint')); }
  @Get('deliveries') deliveries(@Query('endpointId') e?: string) { return this.hooks.deliveries(e ? id(e, 'endpoint') : null); }
  @Post('deliveries/:id/retry') @HttpCode(200) retry(@Param('id') p: string) { return this.hooks.retry(id(p, 'delivery')); }

  @Get('api-keys') listKeys() { return this.keys.list(); }
  @Post('api-keys') createKey(@Body() body: unknown, @CurrentActor() actor: Actor) { return this.keys.create(actor, parse(NewKey, body)); }
  @Post('api-keys/:id/revoke') @HttpCode(200) revoke(@Param('id') p: string) { return this.keys.revoke(id(p, 'API key')); }
}

/** The LIS posts results (FHIR Observations) here with an API key (lis:write). */
@Controller('v1/fhir/r4/lis')
@TenantPublic()
export class LisResultsController {
  constructor(private readonly lis: LisService, private readonly keys: ApiKeysService) {}

  @Post('results')
  @HttpCode(200)
  async results(@Body() body: unknown, @Headers('authorization') auth: string | undefined, @Res({ passthrough: true }) reply: any) {
    reply.header('content-type', 'application/fhir+json; charset=utf-8');
    try {
      const k = await this.keys.authenticate(auth, 'lis:write', 'integrations.lis');
      const outcomes = await this.lis.receive(k, this.lis.parse(body));
      const failed = outcomes.filter((o) => o.status >= 300);
      if (failed.length === outcomes.length) reply.status(failed[0].status === 404 ? 404 : 422);
      return {
        resourceType: 'OperationOutcome',
        issue: outcomes.map((o) => (o.status < 300
          ? { severity: 'information', code: 'informational', details: { text: `${o.orderNo}: ${o.entered} value(s) entered${o.allResulted ? '; all tests resulted, waiting for the pathologist' : ''}` } }
          : { severity: 'error', code: o.status === 404 ? 'not-found' : 'processing', details: { text: `${o.orderNo}: ${o.error}` } })),
      };
    } catch (e) {
      const d = e instanceof DomainError ? e : new DomainError(500, 'INTERNAL', 'unexpected error');
      reply.status(d.status);
      return outcome(d.status, d.code, d.message);
    }
  }
}

/** Events → webhook deliveries, and lab orders → the LIS. */
@Injectable()
export class IntegrationConsumers implements OnModuleInit {
  constructor(private readonly registry: ConsumerRegistry, private readonly hooks: WebhooksService, private readonly lis: LisService) {}
  onModuleInit() {
    const handlers: Record<string, (e: any, db: any) => Promise<void>> = Object.fromEntries(Object.values(WEBHOOK_EVENTS).map((v) => [v.internal, (e: any, db: any) => this.hooks.onEvent(db!, e)]));
    this.registry.register({ group: 'integration.webhooks', topics: [Topics.scheduling, Topics.patient, Topics.diagnostics, Topics.billing], handlers });
    this.registry.register({ group: 'integration.lis', topics: [Topics.diagnostics], handlers: { [EventTypes.labOrderInLab]: (e, db) => this.lis.onInLab(db!, e) } });
  }
}
