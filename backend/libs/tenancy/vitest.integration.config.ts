import { defineConfig } from 'vitest/config';

// Needs local infra + `mc db bootstrap` + at least the tenants created by `mc tenant create` (citycare, sunrise).
export default defineConfig({ test: { include: ['test/**/*.int.spec.ts'], testTimeout: 30_000, setupFiles: ['test/setup.ts'] } });
