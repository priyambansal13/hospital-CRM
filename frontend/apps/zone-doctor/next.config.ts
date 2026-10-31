import type { NextConfig } from 'next';
import { join } from 'node:path';

/** doctor zone, served under /doctor (the shell rewrites /doctor/* here). */
try { process.loadEnvFile(join(process.cwd(), '../../.env')); } catch { /* CI/containers set env directly */ }

const nextConfig: NextConfig = {
  basePath: '/doctor',
  output: 'standalone',
  outputFileTracingRoot: join(process.cwd(), '../..'),
  poweredByHeader: false,
  // 15 MB: consultation recordings for the AI scribe go through a server action
  experimental: { serverActions: { allowedOrigins: ['*.localhost:3400', '*.medicare.app'], bodySizeLimit: '15mb' } },
};

export default nextConfig;
