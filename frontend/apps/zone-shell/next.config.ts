import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shell zone: owns '/' (landing, sign-in, /auth/*) and rewrites each zone's basePath to that zone (Multi-Zones).
 * Rewrites are fixed at BUILD time. Zone URL = ZONE_<NAME>_URL, else ZONE_URL_TEMPLATE ("http://zone-{name}:3000" in
 * the Docker image: Kubernetes service names, so one image works in every namespace), else http://localhost:<port>. Hospital host is kept in
 * x-forwarded-host, so every zone knows which hospital it is serving.
 */
try { process.loadEnvFile(join(process.cwd(), '../../.env')); } catch { /* CI/containers set env directly */ }

interface Zone { name: string; port: number; basePath: string }
const { zones } = JSON.parse(readFileSync(join(process.cwd(), '../../zones.json'), 'utf8')) as { zones: Zone[] };
const zoneUrl = (z: Zone) =>
  process.env[`ZONE_${z.name.toUpperCase().replace(/-/g, '_')}_URL`] ??
  (process.env.ZONE_URL_TEMPLATE ? process.env.ZONE_URL_TEMPLATE.replace('{name}', z.name).replace('{port}', String(z.port)) : `http://localhost:${z.port}`);

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(process.cwd(), '../..'),
  poweredByHeader: false,
  experimental: { serverActions: { allowedOrigins: ['*.localhost:3400', '*.medicare.app'] } },
  async rewrites() {
    return zones.filter((z) => z.basePath).flatMap((z) => [
      { source: z.basePath, destination: `${zoneUrl(z)}${z.basePath}` },
      { source: `${z.basePath}/:path*`, destination: `${zoneUrl(z)}${z.basePath}/:path*` },
    ]);
  },
};

export default nextConfig;
