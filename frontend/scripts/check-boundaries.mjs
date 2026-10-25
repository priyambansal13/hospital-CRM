#!/usr/bin/env node
// Zones never import from each other; shared code lives in packages/* (docs/MICROFRONTENDS.md §3).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const zonePkgs = new Set(readdirSync(join(ROOT, 'apps')).map((d) => JSON.parse(readFileSync(join(ROOT, 'apps', d, 'package.json'), 'utf8')).name));
const problems = [];
function* files(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (!['node_modules', 'dist', '.next'].includes(f)) yield* files(p); }
    else if (/\.(ts|tsx|mjs|js)$/.test(f)) yield p;
  }
}
for (const base of ['apps', 'packages']) {
  for (const unit of readdirSync(join(ROOT, base))) {
    for (const f of files(join(ROOT, base, unit))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (zonePkgs.has(spec)) problems.push(`${relative(ROOT, f)} imports zone ${spec}`);
        if (spec.startsWith('.')) {
          const rel = relative(join(ROOT, base), join(f, '..', spec));
          if (!rel.startsWith(unit) && !rel.startsWith('..' + '/zones.json') && !spec.endsWith('zones.json')) problems.push(`${relative(ROOT, f)} reaches outside ${unit} via ${spec}`);
        }
      }
    }
  }
}
if (problems.length) { console.error(`boundary violations:\n - ${problems.join('\n - ')}`); process.exit(1); }
console.log('zone boundaries ok');
