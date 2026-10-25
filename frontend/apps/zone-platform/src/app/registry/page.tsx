import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Card, PageHeader } from '@mc/ui';
import { get, type RegistryModule } from '@/lib/console';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** Read-only view of the module manifests (developer-owned, backend/modules): what plans can be built from. */
export default async function Registry() {
  await zoneCapabilities('platform', '/platform/registry');
  const modules = await get<RegistryModule[]>('/registry');
  const names = new Map(modules.map((m) => [m.key, m.name]));
  return (
    <ZoneFrame zone="platform" path="/platform/registry" zones={ZONES}>
      <PageHeader title="Modules" subtitle="What developers have built (from the module manifests). Plans combine these; changing them needs a release." />
      {modules.map((m) => (
        <Card key={m.key} title={`${m.name} · v${m.version}`}>
          <p style={{ marginTop: 0 }}>
            <code>{m.key}</code>{m.alwaysOn ? <> <Badge tone="success">always on</Badge></> : null}{m.internal ? <> <Badge>internal</Badge></> : null}
            {m.dependsOn.length ? <span className="mc-meta"> · needs {m.dependsOn.map((d) => names.get(d) ?? d).join(', ')}</span> : null}
            <span className="mc-meta"> · served by {m.services.join(', ')}{m.lifecycle.length ? ` · switch-on/off hooks: ${m.lifecycle.join(', ')}` : ''}</span>
          </p>
          <dl className="mc-dl">
            <dt>Features</dt><dd>{m.features.length ? m.features.map((f) => `${f.name}${f.type === 'LIMIT' ? ` (limit, ${f.unit})` : ''}`).join(' · ') : '—'}</dd>
            <dt>Settings</dt><dd>{m.settings.length ? m.settings.map((s) => `${s.name}${s.planBounded ? ' (plan sets the range)' : ''}`).join(' · ') : '—'}</dd>
            <dt>Permissions</dt><dd className="mc-meta">{m.permissions.map((p) => p.code).join(' · ') || '—'}</dd>
          </dl>
        </Card>
      ))}
    </ZoneFrame>
  );
}
