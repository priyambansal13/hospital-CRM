#!/usr/bin/env node
// Module boundaries (docs/MICROSERVICES.md §1): a service never imports another service's code, and libs never
// import services. Services talk through HTTP APIs and events only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const servicePkgs = new Set(readdirSync(join(ROOT, 'services')).map((d) => JSON.parse(readFileSync(join(ROOT, 'services', d, 'package.json'), 'utf8')).name));
const problems = [];

function* files(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (!['node_modules', 'dist'].includes(f)) yield* files(p); }
    else if (/\.(ts|mts|js|mjs)$/.test(f)) yield p;
  }
}

for (const [kind, base] of [['service', 'services'], ['lib', 'libs']]) {
  for (const unit of readdirSync(join(ROOT, base))) {
    const src = join(ROOT, base, unit);
    for (const f of files(src)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (servicePkgs.has(spec)) problems.push(`${relative(ROOT, f)} imports service package ${spec}`);
        if (spec.startsWith('.')) {
          const target = join(f, '..', spec);
          const rel = relative(join(ROOT, base), target);
          if (rel.startsWith('..') || !rel.startsWith(unit)) problems.push(`${relative(ROOT, f)} reaches outside its ${kind} via ${spec}`);
        }
      }
    }
  }
}
if (problems.length) { console.error(`module boundary violations:\n - ${problems.join('\n - ')}`); process.exit(1); }
console.log('module boundaries ok');
