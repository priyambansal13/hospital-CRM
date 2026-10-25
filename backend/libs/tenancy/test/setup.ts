import { existsSync } from 'node:fs';
const f = new URL('../../../.env', import.meta.url).pathname;
if (existsSync(f)) process.loadEnvFile(f);
