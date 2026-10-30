import { Logger } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics (review H-3), served on a separate port (METRICS_PORT, default service port + 5000; 0 = off) so
 * they are never reachable through the API gateway. Labels never carry patient data: routes are templates
 * (/v1/appointments/:id), hospitals are slugs.
 */
export const metrics = new Registry();
collectDefaultMetrics({ register: metrics, prefix: 'mc_' });

export const httpDuration = new Histogram({
  name: 'mc_http_request_duration_seconds', help: 'HTTP requests by route template and status', registers: [metrics],
  labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
export const outboxPending = new Gauge({ name: 'mc_outbox_pending', help: 'Events written but not yet published to Kafka (last relay pass)', registers: [metrics] });
export const outboxPublished = new Counter({ name: 'mc_outbox_published_total', help: 'Events published by the outbox relay', registers: [metrics] });
export const dlqMessages = new Counter({ name: 'mc_dlq_messages_total', help: 'Events that failed every retry and went to a dead-letter topic', registers: [metrics], labelNames: ['topic', 'consumer'] });
export const retentionDeleted = new Counter({ name: 'mc_retention_deleted_total', help: 'Rows removed by retention (outbox, processed_events)', registers: [metrics], labelNames: ['table'] });

let server: Server | undefined;
export function startMetricsServer(defaultPort: number) {
  const port = Number(process.env.METRICS_PORT ?? defaultPort + 5000);
  if (!port || server) return;
  server = createServer(async (req, res) => {
    if (req.url !== '/metrics') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': metrics.contentType }).end(await metrics.metrics());
  });
  server.on('error', (e) => new Logger('Metrics').warn(`metrics port ${port}: ${e.message}`));
  server.listen(port, '0.0.0.0');
}
export function stopMetricsServer() { server?.close(); server = undefined; }
