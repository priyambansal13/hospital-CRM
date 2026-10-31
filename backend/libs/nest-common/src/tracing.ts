/**
 * OpenTelemetry tracing (review H-3 follow-up). Loaded BEFORE the service so http, fetch, pg and ioredis can be patched:
 *
 *   NODE_OPTIONS="--import @mc/nest-common/tracing" node dist/main.js
 *
 * Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. http://otel-collector:4318). The service name comes from
 * OTEL_SERVICE_NAME or SERVICE_NAME. Events carry the W3C traceparent (CloudEvents distributed-tracing extension),
 * so a consumer's work joins the trace of the request that caused it.
 *
 * Spans never carry patient data: SQL is parameterised (values are not recorded), query strings are dropped from
 * URLs (they can hold a phone number or an e-mail), and Redis spans keep only the command name (keys hold phone numbers).
 */
import { register } from 'node:module';
import { basename } from 'node:path';
import { loadServiceEnv } from './env.js';

loadServiceEnv(); // locally the endpoint can come from backend/.env
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== 'true') {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  const [{ NodeSDK }, { OTLPTraceExporter }, { HttpInstrumentation }, { UndiciInstrumentation }, { PgInstrumentation }, { IORedisInstrumentation }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-proto'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-undici'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-ioredis'),
  ]);
  const exporter = new OTLPTraceExporter();
  const send = exporter.export.bind(exporter);
  exporter.export = (spans, done) => {
    for (const s of spans) scrub(s.attributes as Record<string, unknown>);
    send(spans, done);
  };
  const quiet = new Set(['/health', '/health/live', '/health/ready', '/metrics']);
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE_NAME ?? basename(process.cwd()),
    traceExporter: exporter,
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => quiet.has((req.url ?? '').split('?')[0]) }),
      new UndiciInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation({ dbStatementSerializer: (cmd) => cmd }),
    ],
  });
  sdk.start();
  const stop = () => void sdk.shutdown().catch(() => undefined);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

/** Drops query strings (and the separate query attribute) from URL attributes, in place. */
export function scrub(a: Record<string, unknown>) {
  for (const k of ['url.full', 'http.url', 'http.target', 'url.original']) {
    if (typeof a[k] === 'string') a[k] = (a[k] as string).split('?')[0];
  }
  delete a['url.query'];
}
