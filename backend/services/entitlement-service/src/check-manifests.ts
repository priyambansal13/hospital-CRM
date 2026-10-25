// CI: `pnpm check:manifests` validates every module manifest and the role templates.
import { loadCatalog } from '@mc/entitlements-sdk/catalog';

try {
  const c = loadCatalog();
  console.log(`ok: ${c.modules.size} modules, ${c.permissionModule.size} permissions, ${c.roles.length} role templates`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
