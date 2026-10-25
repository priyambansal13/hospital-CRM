import type { NextConfig } from 'next';
import { join } from 'node:path';

/** account zone, served under /account (the shell rewrites /account/* here). */
try { process.loadEnvFile(join(process.cwd(), '../../.env')); } catch { /* CI/containers set env directly */ }

const nextConfig: NextConfig = {
  basePath: '/account',
  output: 'standalone',
  outputFileTracingRoot: join(process.cwd(), '../..'),
  poweredByHeader: false,
  experimental: { serverActions: { allowedOrigins: ['*.localhost:3400', '*.medicare.app'] } },
};

export default nextConfig;
