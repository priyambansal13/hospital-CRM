import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, CheckboxGroup, Field, PageHeader, Table } from '@mc/ui';
import { cookies } from 'next/headers';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { addEndpoint, addKey, endpointAction, retryDelivery, revokeKey } from './actions';

export const dynamic = 'force-dynamic';

interface Endpoint { id: string; kind: 'WEBHOOK' | 'LIS'; name: string; url: string; events: string[]; secretHint: string; active: boolean; version: number }
interface Delivery { id: string; endpointId: string; eventType: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string; deliveredAt: string | null }
interface Key { id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
interface Catalog { events: { key: string; label: string }[]; scopes: { key: string; label: string }[] }
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : '—');
const TONE: Record<string, 'success' | 'warning' | 'danger'> = { DELIVERED: 'success', PENDING: 'warning', FAILED: 'danger' };

function EndpointRow({ e }: { e: Endpoint }) {
  const btn = (what: string, label: string, variant: 'ghost' | 'danger' = 'ghost') => (
    <form action={endpointAction}><input type="hidden" name="id" value={e.id} /><input type="hidden" name="version" value={e.version} /><input type="hidden" name="what" value={what} /><Button variant={variant}>{label}</Button></form>
  );
  return <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{btn('test', 'Send a test')}{btn('rotate', 'New secret')}{btn(e.active ? 'off' : 'on', e.active ? 'Switch off' : 'Switch on')}</span>;
}

/** Admin: the hospital's integrations (Phase 27): webhooks, the lab instrument system (LIS), API keys for FHIR. */
export default async function Integrations({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await zoneCapabilities('admin', '/admin/integrations');
  const { accessToken: token } = (await getSession())!;
  const [cat, hooks, lis, deliveries, keys] = await Promise.all([
    api<Catalog>('/api/integration/v1/integrations/catalog', { token }), api<Endpoint[]>('/api/integration/v1/integrations/endpoints', { token }),
    api<Endpoint[]>('/api/integration/v1/integrations/endpoints?kind=LIS', { token }), api<Delivery[]>('/api/integration/v1/integrations/deliveries', { token }),
    api<Key[]>('/api/integration/v1/integrations/api-keys', { token }),
  ]);
  const sp = await searchParams;
  let fresh: { label: string; value: string } | null = null;
  try { fresh = JSON.parse((await cookies()).get('mc-once')?.value ?? 'null'); } catch { fresh = null; }
  const names = new Map([...hooks, ...lis].map((e) => [e.id, e.name]));

  return (
    <ZoneFrame zone="admin" path="/admin/integrations" zones={ZONES}>
      <PageHeader title="Integrations" subtitle="Connect your own systems: events pushed to your HIS, lab instruments through your LIS, and a FHIR API for authorised software." />
      <Flash ok={sp.ok} error={sp.error} />
      {fresh && sp.ok ? (
        <Alert tone="info"><strong>{fresh.label}:</strong> <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{fresh.value}</code><br />Copy it now and keep it safe: it is not shown again.</Alert>
      ) : null}

      <Card title="Webhooks">
        <p className="mc-muted" style={{ marginTop: 0 }}>We POST JSON to your address when these things happen, signed with <code>x-medicare-signature: t=…,v1=HMAC-SHA256(secret, &quot;t.body&quot;)</code>. Failed deliveries are retried for about 7 hours.</p>
        <Table
          rows={hooks}
          empty="No webhooks yet."
          columns={[
            { header: 'Endpoint', cell: (e: Endpoint) => <><strong>{e.name}</strong><br /><span className="mc-meta">{e.url}</span></> },
            { header: 'Events', cell: (e) => <span className="mc-meta">{e.events.join(', ')}</span> },
            { header: 'Secret', cell: (e) => <code>{e.secretHint}</code> },
            { header: 'On', cell: (e) => <Badge tone={e.active ? 'success' : 'neutral'}>{e.active ? 'On' : 'Off'}</Badge> },
            { header: 'Action', cell: (e) => <EndpointRow e={e} /> },
          ]}
        />
        <form action={addEndpoint} className="mc-form" style={{ marginTop: 16 }}>
          <input type="hidden" name="kind" value="WEBHOOK" />
          <Field label="Name" name="name" required placeholder="Hospital HIS" />
          <Field label="Address (https://)" name="url" required placeholder="https://his.example.in/medicare" />
          <div className="mc-field-wide"><CheckboxGroup legend="Send these events" name="events" options={cat.events.map((e) => ({ value: e.key, label: `${e.label} (${e.key})` }))} defaultValues={['appointment.booked', 'appointment.cancelled']} /></div>
          <Button>Add webhook</Button>
        </form>
      </Card>

      <Card title="Lab instruments (LIS)">
        <p className="mc-muted" style={{ marginTop: 0 }}>When an order&apos;s samples reach the lab, we send it to your LIS as FHIR (ServiceRequest + tube barcodes). Your LIS posts the values back to <code>/api/integration/v1/fhir/r4/lis/results</code> with an API key that may send lab results; a pathologist still verifies every report.</p>
        {lis.length ? (
          <Table rows={lis} empty="" columns={[
            { header: 'Connection', cell: (e: Endpoint) => <><strong>{e.name}</strong><br /><span className="mc-meta">{e.url}</span></> },
            { header: 'Secret', cell: (e) => <code>{e.secretHint}</code> },
            { header: 'On', cell: (e) => <Badge tone={e.active ? 'success' : 'neutral'}>{e.active ? 'On' : 'Off'}</Badge> },
            { header: 'Action', cell: (e) => <EndpointRow e={e} /> },
          ]} />
        ) : (
          <form action={addEndpoint} className="mc-form">
            <input type="hidden" name="kind" value="LIS" />
            <Field label="Name" name="name" required placeholder="Analyzer bridge" />
            <Field label="Address (https://)" name="url" required placeholder="https://lis.example.in/orders" />
            <Button>Connect the LIS</Button>
          </form>
        )}
      </Card>

      <Card title="API keys">
        <p className="mc-muted" style={{ marginTop: 0 }}>For software that reads from MediCare (FHIR R4: Patient, Appointment, DiagnosticReport at <code>/api/integration/v1/fhir/r4</code>) or sends lab results. Every read is in the audit log under the key&apos;s name.</p>
        <Table
          rows={keys}
          empty="No API keys yet."
          columns={[
            { header: 'Key', cell: (k: Key) => <><strong>{k.name}</strong><br /><code className="mc-meta">mck_{k.prefix}_…</code></> },
            { header: 'May', cell: (k) => <span className="mc-meta">{k.scopes.map((s) => cat.scopes.find((x) => x.key === s)?.label ?? s).join('; ')}</span> },
            { header: 'Last used', cell: (k) => when(k.lastUsedAt) },
            { header: 'Status', cell: (k) => <Badge tone={k.revokedAt ? 'neutral' : 'success'}>{k.revokedAt ? 'Revoked' : 'Active'}</Badge> },
            { header: 'Action', cell: (k) => (k.revokedAt ? null : <form action={revokeKey}><input type="hidden" name="id" value={k.id} /><Button variant="danger">Revoke</Button></form>) },
          ]}
        />
        <form action={addKey} className="mc-form" style={{ marginTop: 16 }}>
          <Field label="Name (who uses it)" name="name" required placeholder="HIS reader" />
          <div className="mc-field-wide"><CheckboxGroup legend="It may" name="scopes" options={cat.scopes.map((s) => ({ value: s.key, label: s.label }))} defaultValues={['fhir:read']} /></div>
          <Button>Create key</Button>
        </form>
      </Card>

      <Card title="Recent deliveries">
        <Table
          rows={deliveries}
          empty="Nothing sent yet."
          columns={[
            { header: 'When', cell: (d: Delivery) => when(d.createdAt) },
            { header: 'To', cell: (d) => names.get(d.endpointId) ?? '—' },
            { header: 'Event', cell: (d) => d.eventType },
            { header: 'Status', cell: (d) => <><Badge tone={TONE[d.status] ?? 'neutral'}>{d.status.toLowerCase()}</Badge>{d.attempts > 1 ? <span className="mc-meta"> · {d.attempts} tries</span> : null}</> },
            { header: 'Detail', cell: (d) => <span className="mc-meta">{d.lastError ?? (d.deliveredAt ? `delivered ${when(d.deliveredAt)}` : '')}</span> },
            { header: '', cell: (d) => (d.status === 'FAILED' ? <form action={retryDelivery}><input type="hidden" name="id" value={d.id} /><Button variant="ghost">Retry</Button></form> : null) },
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
