import 'reflect-metadata';
import { ConsoleLogger, Logger, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { trace } from '@opentelemetry/api';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { RequestContext } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { loadServiceEnv } from './env.js';
import { httpDuration, startMetricsServer } from './metrics.js';

export interface ServiceOptions {
  name: string;
  /** default port; PORT env overrides */
  port: number;
  bodyLimitBytes?: number;
  /** keep the raw request body (req.rawBody), e.g. to verify webhook signatures */
  rawBody?: boolean;
}

/**
 * Standard service bootstrap: backend .env, Fastify, JSON logs, per-request context (request id, tenant, actor)
 * via AsyncLocalStorage, access log without PHI, shutdown hooks.
 */
export async function createService(module: Type<unknown>, opts: ServiceOptions): Promise<NestFastifyApplication> {
  loadServiceEnv();
  process.env.SERVICE_NAME ??= opts.name;
  const adapter = new FastifyAdapter({ trustProxy: true, bodyLimit: opts.bodyLimitBytes ?? 1_048_576, genReqId: (req: { headers: Record<string, unknown> }) => String(req.headers['x-request-id'] ?? randomUUID()) });
  const fastify = adapter.getInstance();
  fastify.addHook('onRequest', (req, _reply, done) => {
    RequestContext.run({ requestId: String(req.id) }, done);
  });
  const access = new Logger('http');
  fastify.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions?.url ?? 'unmatched'; // the template, never the ids in the URL
    const span = trace.getActiveSpan(); // the http server span when tracing is on
    if (span && req.routeOptions?.url) { span.setAttribute('http.route', route); span.updateName(`${req.method} ${route}`); }
    if (!route.startsWith('/health')) httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
    if (!req.url.startsWith('/health')) {
      const rc = RequestContext.current();
      access.log({ requestId: req.id, method: req.method, route: req.routeOptions?.url ?? req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime), tenant: rc?.tenant?.slug, actor: rc?.actor?.kind });
    }
    done();
  });
  const logger = process.env.LOG_FORMAT === 'pretty' ? new ConsoleLogger(opts.name) : new ConsoleLogger({ json: true, colors: false, prefix: opts.name });
  const app = await NestFactory.create<NestFastifyApplication>(module, adapter, { logger, rawBody: opts.rawBody ?? false });
  app.enableShutdownHooks();
  return app;
}

export async function bootstrapService(module: Type<unknown>, opts: ServiceOptions): Promise<NestFastifyApplication> {
  const app = await createService(module, opts);
  const port = Number(process.env.PORT ?? opts.port);
  await app.listen(port, '0.0.0.0');
  startMetricsServer(opts.port);
  Logger.log(`${opts.name} on http://localhost:${port}`, 'Bootstrap');
  return app;
}
