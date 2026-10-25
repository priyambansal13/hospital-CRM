import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { testTimeout: 30_000, setupFiles: ['../../libs/tenancy/test/setup.ts'] } });
