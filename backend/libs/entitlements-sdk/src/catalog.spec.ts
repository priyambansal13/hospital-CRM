import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalog, modulesDir, templateGrants } from './catalog.js';

const roles = 'roles:\n  - { code: TENANT_ADMIN, name: Admin, grantsAll: true }\n  - { code: DOCTOR, name: Doctor }\n';
function dirWith(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'mods-'));
  writeFileSync(join(d, 'roles.yaml'), roles);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
  return d;
}

describe('module manifests', () => {
  it('the real manifests in backend/modules are valid', () => {
    const c = loadCatalog(modulesDir());
    expect(c.modules.has('core')).toBe(true);
    expect(templateGrants(c, 'PATIENT', c.modules.keys())).toContain('appointment:create:own');
  });

  it('rejects unknown dependencies, undeclared permissions, bad codes and cycles', () => {
    const d = dirWith({
      'a.module.yaml': 'key: a\nname: A\nversion: 1\ndependsOn: [b]\npermissions: [{ code: "x:y:own", description: d }]\nnav: [{ key: n, label: N, zone: admin, href: /admin, permissions: ["z:z:own"] }]\n',
      'b.module.yaml': 'key: b\nname: B\nversion: 1\ndependsOn: [a, ghost]\npermissions: [{ code: "BAD", description: d }]\ndefaultRoleGrants: { NOBODY: ["x:y:own"] }\n',
    });
    expect(() => loadCatalog(d)).toThrow(/ghost|undeclared permission|cycle|resource:action:scope/);
    try { loadCatalog(d); } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/b\.module\.yaml: permissions\.0\.code/);
    }
  });

  it('detects a dependency cycle between valid modules', () => {
    const d = dirWith({
      'a.module.yaml': 'key: a\nname: A\nversion: 1\ndependsOn: [b]\n',
      'b.module.yaml': 'key: b\nname: B\nversion: 1\ndependsOn: [a]\n',
    });
    expect(() => loadCatalog(d)).toThrow(/dependency cycle/);
  });
});
