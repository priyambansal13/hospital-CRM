#!/usr/bin/env node
// Scaffold a new microservice that follows every platform convention:
//   pnpm gen service <name> [--control] [--no-tenant] [--port 4410]
// Then: node ../platform/scripts/mc.mjs configure && mc db bootstrap && pnpm build && mc migrate && mc gateway sync
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const [, , kind, name, ...rest] = process.argv;
const flag = (f) => rest.includes(f);
const opt = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };

if (kind !== 'service' || !/^[a-z][a-z-]+$/.test(name ?? '')) {
  console.error('usage: pnpm gen service <name> [--control] [--no-tenant] [--port N]   (name like "provider")');
  process.exit(1);
}
const dirName = `${name}-service`;
const dir = join(ROOT, 'services', dirName);
if (existsSync(dir)) { console.error(`${dirName} already exists`); process.exit(1); }
const schema = name.replaceAll('-', '_');
const ports = readdirSync(join(ROOT, 'services')).map((d) => JSON.parse(readFileSync(join(ROOT, 'services', d, 'package.json'), 'utf8')).mc?.port ?? 0);
const port = Number(opt('--port') ?? Math.max(4400, ...ports) + 1);
const control = flag('--control');
const tenant = !flag('--no-tenant');
const Pascal = name.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('');

const template = JSON.parse(readFileSync(join(ROOT, 'services/tenant-service/package.json'), 'utf8'));
const pkg = {
  ...template,
  name: `@mc/${dirName}`,
  mc: { kind: 'service', port, schema, control, tenant, route: name, owner: 'team-unassigned', publishes: [`${schema}.events`], consumes: [] },
};
const files = {
  'package.json': JSON.stringify(pkg, null, 2) + '\n',
  'tsconfig.json': readFileSync(join(ROOT, 'services/tenant-service/tsconfig.json'), 'utf8'),
  'tsconfig.build.json': readFileSync(join(ROOT, 'services/tenant-service/tsconfig.build.json'), 'utf8'),
  'vitest.config.ts': readFileSync(join(ROOT, 'services/tenant-service/vitest.config.ts'), 'utf8'),
  'src/main.ts': `import { bootstrapService } from '@mc/nest-common';\nimport { AppModule } from './app.module.js';\n\nawait bootstrapService(AppModule, { name: '${dirName}', port: ${port} });\n`,
  'src/migrate.ts': `import { loadServiceEnv } from '@mc/nest-common';\nimport { migrateCli } from '@mc/tenancy';\nimport { dirname, join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n\nloadServiceEnv();\nawait migrateCli({ schema: '${schema}', migrationsDir: join(dirname(fileURLToPath(import.meta.url)), '../migrations') });\n`,
  'src/app.module.ts': `import { Module } from '@nestjs/common';\nimport { CoreModule } from '@mc/nest-common';\nimport { EntitlementsModule } from '@mc/entitlements-sdk';\nimport { ${Pascal}Controller } from './${name}.controller.js';\n\n@Module({\n  imports: [CoreModule.forRoot({ schema: '${schema}', control: ${control}, tenant: ${tenant}, relay: true }), EntitlementsModule],\n  controllers: [${Pascal}Controller],\n})\nexport class AppModule {}\n`,
  [`src/${name}.controller.ts`]: `import { Controller, Get } from '@nestjs/common';\nimport { CurrentActor } from '@mc/nest-common';\nimport { RequireModule } from '@mc/entitlements-sdk';\nimport { type Actor, TenantContext } from '@mc/tenancy';\n\n// Replace with real endpoints. Every route: a module (and usually a permission) from a module manifest.\n@Controller('v1/${name}')\n@RequireModule('core')\nexport class ${Pascal}Controller {\n  @Get('ping')\n  ping(@CurrentActor() actor: Actor) {\n    return { service: '${dirName}', tenant: TenantContext.require().slug, actor: actor.kind };\n  }\n}\n`,
  ...(tenant ? { 'migrations/tenant/0001_init.sql': `-- ${dirName}: tables in every hospital's own database (schema "${schema}").\n-- outbox, processed_events and schema_migrations are created automatically.\nSELECT 1;\n` } : {}),
  ...(control ? { 'migrations/control/0001_init.sql': `-- ${dirName}: control-plane tables (schema "${schema}" in mc_control). No clinical data here.\nSELECT 1;\n` } : {}),
  'test/.gitkeep': '',
};
for (const [f, content] of Object.entries(files)) {
  mkdirSync(join(dir, f, '..'), { recursive: true });
  writeFileSync(join(dir, f), content);
}
console.log(`created services/${dirName} (port ${port}, schema ${schema}, control=${control}, tenant=${tenant})
next:
  pnpm install && pnpm build
  node ../platform/scripts/mc.mjs configure && node ../platform/scripts/mc.mjs db bootstrap
  node ../platform/scripts/mc.mjs migrate && node ../platform/scripts/mc.mjs gateway sync
  add a leak-test fixture for any route with path params (platform/tests/tenancy-leak.mjs)`);
