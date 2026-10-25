import { defineConfig } from '@playwright/test';

// Needs: infra up, backend services, zones on :3400/:3405, and hospitals citycare + sunrise (mc tenant create).
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  // dev mode compiles each page on first visit; give assertions room
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
