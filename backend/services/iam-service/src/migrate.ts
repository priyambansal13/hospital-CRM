import { loadServiceEnv } from '@mc/nest-common';
import { migrateCli } from '@mc/tenancy';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

loadServiceEnv();
await migrateCli({ schema: 'iam', migrationsDir: join(dirname(fileURLToPath(import.meta.url)), '../migrations') });
