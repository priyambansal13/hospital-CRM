import type { NextConfig } from 'next';
import { join } from 'node:path';

/** doctor zone, served under /doctor (the shell rewrites /doctor/* here). */
try { process.loadEnvFile(join(process.cwd(), '../../.env')); } catch { /* CI/containers set env directly */ }

const nextConfig: NextConfig = {
  basePath: '/doctor',
  output: 'standalone',
  outputFileTracingRoot: join(process.cwd(), '../..'),
  poweredByHeader: false,
  experimental: { serverActions: { allowedOrigins: ['*.localhost:3400', '*.medicare.app'] } },
};

export default nextConfig;
