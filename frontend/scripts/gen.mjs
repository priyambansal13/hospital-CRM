#!/usr/bin/env node
// Scaffold a new zone: pnpm gen zone <name> --base /care [--port 3401]
// Adds it to zones.json (the shell rewrites <base>/* to it) and creates a Next.js app using the shared packages.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const [, , kind, name, ...rest] = process.argv;
const opt = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
const base = opt('--base');
if (kind !== 'zone' || !/^[a-z][a-z-]+$/.test(name ?? '') || !base?.startsWith('/')) {
  console.error('usage: pnpm gen zone <name> --base /path [--port N]');
  process.exit(1);
}
const zonesFile = join(ROOT, 'zones.json');
const zj = JSON.parse(readFileSync(zonesFile, 'utf8'));
if (zj.zones.some((z) => z.name === name || z.basePath === base)) { console.error('zone name or base already used'); process.exit(1); }
const port = Number(opt('--port') ?? Math.max(...zj.zones.map((z) => z.port)) + 1);
const dir = join(ROOT, 'apps', `zone-${name}`);
if (existsSync(dir)) { console.error(`${dir} exists`); process.exit(1); }

const tpl = join(ROOT, 'apps/zone-admin');
mkdirSync(join(dir, 'src/app'), { recursive: true });
for (const f of ['tsconfig.json', 'next-env.d.ts', 'src/lib/zones.ts', 'src/lib/flash.tsx']) cpSync(join(tpl, f), join(dir, f), { recursive: true });
const pkg = JSON.parse(readFileSync(join(tpl, 'package.json'), 'utf8'));
pkg.name = `@mc/zone-${name}`;
pkg.mc = { kind: 'zone', port, basePath: base, owner: 'team-unassigned' };
for (const k of ['dev', 'start']) pkg.scripts[k] = pkg.scripts[k].replace(/-p \d+/, `-p ${port}`);
writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(join(dir, 'next.config.ts'), readFileSync(join(tpl, 'next.config.ts'), 'utf8').replaceAll("'/admin'", `'${base}'`).replace('admin zone, served under /admin (the shell rewrites /admin/* here)', `${name} zone, served under ${base} (the shell rewrites ${base}/* here)`));
writeFileSync(join(dir, 'src/app/layout.tsx'), readFileSync(join(tpl, 'src/app/layout.tsx'), 'utf8').replace('Admin · MediCare', `${name[0].toUpperCase()}${name.slice(1)} · MediCare`));
writeFileSync(join(dir, 'src/app/page.tsx'), `import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Card, PageHeader } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

// Reachable only for users with at least one nav item in zone "${name}" (declare them in a module manifest).
export default async function Home() {
  await zoneCapabilities('${name}', '${base}');
  return (
    <ZoneFrame zone="${name}" path="${base}" zones={ZONES}>
      <PageHeader title="${name}" />
      <Card><p>Zone ${name} is ready.</p></Card>
    </ZoneFrame>
  );
}
`);
zj.zones.push({ name, port, basePath: base, owner: 'team-unassigned', title: name });
writeFileSync(zonesFile, JSON.stringify(zj, null, 2) + '\n');
console.log(`created apps/zone-${name} on port ${port}, served under ${base}. Run pnpm install, then rebuild the shell (rewrites are read at build time).`);
