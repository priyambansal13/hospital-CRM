import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { type PlatformStatus, platformStatus, STATE_TEXT } from '@mc/features/status';
import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { Badge, Button, Card, Field, PageHeader } from '@mc/ui';
import { when } from '@/lib/console';
import { Flash } from '@/lib/flash';
import { postIncident, postUpdate } from '@/lib/status-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

type Incident = PlatformStatus['incidents'][number];
const STATUSES = ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'];

/**
 * The public status page from the inside (docs/OPERATIONS.md §5, runbooks/incident-communication.md): what the
 * automatic checks say, and the incidents support posts. Patients and hospitals see the result at /status.
 */
export default async function StatusConsole({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('platform', '/platform/status');
  const sp = await searchParams;
  const { accessToken: token } = (await getSession())!;
  const [status, incidents] = await Promise.all([
    platformStatus().catch(() => null),
    api<Incident[]>('/api/tenant/v1/platform/status/incidents', { token }),
  ]);
  const manage = can(caps, 'status:manage:tenant');
  const open = incidents.filter((i) => i.status !== 'RESOLVED');
  return (
    <ZoneFrame zone="platform" path="/platform/status" zones={ZONES}>
      <PageHeader title="Status page" subtitle="What hospitals and patients see at /status. Post an incident within 15 minutes of a page (runbook: incident communication)." />
      <Flash ok={sp.ok} error={sp.error} />
      <Card title="Right now">
        {status ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {status.components.map((c) => <li key={c.key} style={{ display: 'flex', justifyContent: 'space-between' }}><span>{c.name} <span className="mc-meta">({c.key})</span></span><Badge tone={STATE_TEXT[c.state].tone}>{STATE_TEXT[c.state].label}</Badge></li>)}
          </ul>
        ) : <p className="mc-meta" style={{ margin: 0 }}>The status API is not answering.</p>}
        <p className="mc-meta" style={{ marginBottom: 0 }}>From the services&apos; health checks, every 30 seconds, plus open incidents. <a href="/status">Public page</a></p>
      </Card>

      {open.map((i) => (
        <Card key={i.id} title={i.title}>
          <p className="mc-meta" style={{ marginTop: 0 }}>{i.impact.toLowerCase()} · {i.status.toLowerCase()} · {i.components.join(', ')} · since {when(i.startsAt)}</p>
          <ul style={{ paddingLeft: 18 }}>{i.updates.map((u, n) => <li key={n}><strong>{u.status.toLowerCase()}</strong> {when(u.at)}: {u.message}</li>)}</ul>
          {manage ? (
            <form action={postUpdate} className="mc-form" aria-label={`Update ${i.title}`}>
              <input type="hidden" name="id" value={i.id} />
              <label className="mc-field"><span>Status</span><select name="status" defaultValue={i.status === 'SCHEDULED' ? 'MONITORING' : i.status}>{STATUSES.map((x) => <option key={x} value={x}>{x.toLowerCase()}</option>)}</select></label>
              <label className="mc-field mc-field-wide"><span>Update (public)</span><textarea name="message" rows={2} required minLength={3} maxLength={2000} /></label>
              <Button>Post update</Button>
            </form>
          ) : null}
        </Card>
      ))}

      {manage ? (
        <Card title="Post an incident or planned maintenance">
          <form action={postIncident} className="mc-form" aria-label="New incident">
            <Field label="Title (public)" name="title" required placeholder="Online booking is failing for some hospitals" />
            <label className="mc-field"><span>Impact</span>
              <select name="impact" defaultValue="MAJOR"><option value="MINOR">Minor (slow or some failures)</option><option value="MAJOR">Major (partly down)</option><option value="CRITICAL">Critical (down)</option><option value="MAINTENANCE">Planned maintenance</option></select>
            </label>
            <fieldset className="mc-fieldset"><legend>Affected</legend>
              {(status?.components ?? []).map((c) => <label key={c.key} className="mc-check"><input type="checkbox" name="components" value={c.key} /> {c.name}</label>)}
            </fieldset>
            <Field label="Starts (maintenance, India time)" name="startsAt" type="datetime-local" />
            <Field label="Ends (maintenance, India time)" name="endsAt" type="datetime-local" />
            <label className="mc-field mc-field-wide"><span>First message (public): what is affected, what to do meanwhile</span><textarea name="message" rows={3} required minLength={3} maxLength={2000} /></label>
            <Button>Post</Button>
          </form>
          <p className="mc-meta" style={{ marginBottom: 0 }}>Never name a hospital or a patient here: the page is public.</p>
        </Card>
      ) : null}

      <Card title="Last 90 days">
        <ul style={{ margin: 0, paddingLeft: 18 }}>{incidents.filter((i) => i.status === 'RESOLVED').map((i) => <li key={i.id}><strong>{i.title}</strong> <span className="mc-meta">{i.impact.toLowerCase()} · {when(i.startsAt)} – {i.resolvedAt ? when(i.resolvedAt) : ''}</span></li>)}</ul>
      </Card>
    </ZoneFrame>
  );
}
