import { type DynamicModule, Global, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown, Optional, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { controlPool, HttpPlacementSource, type PlacementSource, TenantDbRouter } from '@mc/tenancy';
import type pg from 'pg';
import { AuthGuard, PLACEMENTS } from './auth/auth.js';
import { ProblemFilter } from './errors.js';
import { type ConsumerSpec, EventConsumer } from './events/consumer.js';
import { OutboxRelay } from './events/relay.js';
import { HealthController } from './health.controller.js';
import { IdempotencyInterceptor } from './idempotency.js';
import { createRedis, REDIS, type Redis } from './redis.js';
import { ModuleHooks, ModuleHooksController } from './module-hooks.js';
import { RouteRegistry, RoutesController } from './routes.controller.js';
import { CONTROL_DB, SERVICE_OPTIONS } from './tokens.js';

export interface CoreOptions {
  /** service schema (control and/or tenant); DB role is svc_<schema> */
  schema: string;
  /** has a schema in the control-plane DB */
  control?: boolean;
  /** has a schema in every tenant DB */
  tenant?: boolean;
  /** run the outbox relay (services that publish events) */
  relay?: boolean;
  /** override where placements come from (tenant-service reads its own catalog) */
  placements?: Provider;
}

/** Feature modules register event consumers here (in onModuleInit); they start on application bootstrap. */
@Injectable()
export class ConsumerRegistry {
  readonly specs: ConsumerSpec[] = [];
  register(spec: ConsumerSpec) {
    this.specs.push(spec);
  }
}

class Lifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Lifecycle');
  private relay?: OutboxRelay;
  private consumers: EventConsumer[] = [];

  constructor(
    @Inject(SERVICE_OPTIONS) private readonly opts: CoreOptions,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource,
    private readonly registry: ConsumerRegistry,
    @Optional() @Inject(CONTROL_DB) private readonly control?: pg.Pool,
    @Optional() @Inject(TenantDbRouter) private readonly router?: TenantDbRouter,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  async onApplicationBootstrap() {
    if (process.env.MC_DISABLE_EVENTS === 'true') return;
    if (this.opts.relay) {
      this.relay = new OutboxRelay({ control: this.control, router: this.router, placements: this.placements });
      await this.relay.start();
    }
    for (const spec of this.registry.specs) {
      const c = new EventConsumer(spec, { control: this.control, router: this.router, placements: this.placements });
      await c.start();
      this.consumers.push(c);
    }
  }

  async onApplicationShutdown() {
    await this.relay?.stop();
    await Promise.all(this.consumers.map((c) => c.stop()));
    await this.router?.close();
    await this.control?.end().catch(() => undefined);
    this.redis?.disconnect();
    this.log.log('stopped');
  }
}

/**
 * Everything a MediCare service needs: placements, tenant DB router, control DB, Redis, global auth guard,
 * RFC 7807 errors, idempotency, health, route registry, outbox relay and consumers.
 */
@Global()
@Module({})
export class CoreModule {
  static forRoot(opts: CoreOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: SERVICE_OPTIONS, useValue: opts },
      opts.placements ?? { provide: PLACEMENTS, useFactory: () => new HttpPlacementSource() },
      { provide: REDIS, useFactory: createRedis },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: ProblemFilter },
      IdempotencyInterceptor,
      RouteRegistry,
      ConsumerRegistry,
      ModuleHooks,
      Lifecycle,
    ];
    if (opts.control) providers.push({ provide: CONTROL_DB, useFactory: () => controlPool(opts.schema) });
    if (opts.tenant) providers.push({ provide: TenantDbRouter, useFactory: (p: PlacementSource) => new TenantDbRouter(p, opts.schema), inject: [PLACEMENTS] });
    return {
      module: CoreModule,
      imports: [DiscoveryModule],
      controllers: [HealthController, RoutesController, ModuleHooksController],
      providers,
      exports: providers.filter((p) => typeof p === 'object' && 'provide' in p && p.provide !== APP_GUARD && p.provide !== APP_FILTER).map((p) => (p as any).provide).concat([IdempotencyInterceptor, RouteRegistry, ConsumerRegistry, ModuleHooks]),
    };
  }
}
