import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Card, PageHeader, Table } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { updateLead } from '@/lib/growth-actions';
import { when } from '@/lib/console';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Line { source: string; medium: string; campaign: string; leads: number; leadsWon: number; signups: number; confirmed: number; ready: number; paid: number }
interface Funnel { days: number; rows: Line[]; total: Omit<Line, 'source' | 'medium' | 'campaign'>; ads: { meta: { configured: boolean; pending: number; lastError: string | null }; conversions: number; withConsent: number } }
interface Lead { id: string; name: string; email: string; phone: string | null; hospitalName: string; city: string | null; segment: string; doctors: number | null; message: string | null; status: string; note: string | null; channel: { source: string; campaign: string }; landing: string | null; createdAt: string; updatedBy: string | null }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  NEW: { label: 'new', tone: 'warning' }, CONTACTED: { label: 'contacted', tone: 'neutral' }, DEMO_DONE: { label: 'demo done', tone: 'neutral' }, WON: { label: 'won', tone: 'success' }, LOST: { label: 'lost', tone: 'danger' },
};
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

/**
 * MediCare's own growth (docs/SEO-AND-ADS.md §3.5): demo requests and signups by campaign, down to paying hospitals,
 * and the conversions reported to ad platforms (consented visitors only, e-mails hashed).
 */
export default async function Growth({ searchParams }: { searchParams: Promise<{ days?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('platform', '/platform/growth');
  const sp = await searchParams;
  const days = [30, 90, 365].includes(Number(sp.days)) ? Number(sp.days) : 90;
  const { accessToken: token } = (await getSession())!;
  const [funnel, leads] = await Promise.all([
    api<Funnel>(`/api/tenant/v1/platform/growth/funnel?days=${days}`, { token }),
    api<Lead[]>('/api/tenant/v1/platform/growth/leads', { token }),
  ]);
  const manage = can(caps, 'customer:manage:tenant');
  const t = funnel.total;
  return (
    <ZoneFrame zone="platform" path="/platform/growth" zones={ZONES}>
      <PageHeader title="Growth" subtitle="Demo requests and signups by campaign, down to paying hospitals." />
      <Flash ok={sp.ok} error={sp.error} />
      <nav className="mc-chips" aria-label="Period">{[30, 90, 365].map((d) => <a key={d} className="mc-chip" aria-current={d === days ? 'true' : undefined} href={`/platform/growth?days=${d}`}>Last {d} days</a>)}</nav>

      <div className="mc-kpis">
        <div className="mc-kpi"><span className="mc-kpi-label">Demo requests</span><span className="mc-kpi-value">{t.leads}</span><span className="mc-kpi-sub">{t.leadsWon} won</span></div>
        <div className="mc-kpi"><span className="mc-kpi-label">Signups started</span><span className="mc-kpi-value">{t.signups}</span><span className="mc-kpi-sub">{pct(t.confirmed, t.signups)} confirmed their e-mail</span></div>
        <div className="mc-kpi"><span className="mc-kpi-label">Hospitals ready</span><span className="mc-kpi-value">{t.ready}</span></div>
        <div className="mc-kpi" data-tone="success"><span className="mc-kpi-label">Paying</span><span className="mc-kpi-value">{t.paid}</span><span className="mc-kpi-sub">{pct(t.paid, t.ready)} of ready</span></div>
      </div>

      <Card title="By campaign">
        <Table rows={funnel.rows} empty="No visits with a campaign yet." columns={[
          { header: 'Source / medium', cell: (r) => <><strong>{r.source}</strong> <span className="mc-meta">/ {r.medium}</span></> },
          { header: 'Campaign', cell: (r) => r.campaign },
          { header: 'Demo requests', cell: (r) => r.leads },
          { header: 'Signups', cell: (r) => r.signups },
          { header: 'Confirmed', cell: (r) => r.confirmed },
          { header: 'Ready', cell: (r) => r.ready },
          { header: 'Paying', cell: (r) => <strong>{r.paid}</strong> },
        ]} />
        <p className="mc-meta" style={{ marginBottom: 0 }}>From the UTM tags of the visit before the signup or request (<code>utm_source</code>, <code>utm_medium</code>, <code>utm_campaign</code>). Ad spend is not here: compare with the ad accounts weekly (§3.5).</p>
      </Card>

      <Card title="Ad platforms">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>{funnel.ads.conversions} conversions in the last 90 days; {funnel.ads.withConsent} from visitors who accepted ad cookies (only these are ever sent).</li>
          <li>Meta Conversions API: {funnel.ads.meta.configured ? <>{funnel.ads.meta.pending ? `${funnel.ads.meta.pending} waiting to send` : 'up to date'}{funnel.ads.meta.lastError ? <> · <Badge tone="danger">last error</Badge> <span className="mc-meta">{funnel.ads.meta.lastError}</span></> : null}</> : <span className="mc-meta">not set up (META_PIXEL_ID and META_CAPI_TOKEN)</span>}</li>
          <li>Google Ads: {manage ? <a href={`/platform/growth/google.csv?days=${days}`}>download the offline-conversion file</a> : 'support can download the offline-conversion file'} and upload it in Google Ads (Goals → Conversions → Uploads).</li>
        </ul>
      </Card>

      <span id="leads" />
      <Card title="Demo requests">
        <Table rows={leads} empty="No demo requests yet." columns={[
          { header: 'When', cell: (l) => <span className="mc-meta">{when(l.createdAt)}</span> },
          { header: 'Who', cell: (l) => <><strong>{l.hospitalName}</strong>{l.city ? `, ${l.city}` : ''}<div className="mc-meta">{l.name} · <a href={`mailto:${l.email}`}>{l.email}</a>{l.phone ? ` · ${l.phone}` : ''}</div><div className="mc-meta">{l.segment.toLowerCase()}{l.doctors != null ? `, ${l.doctors} doctors` : ''}</div>{l.message ? <div className="mc-meta">“{l.message}”</div> : null}</> },
          { header: 'Came from', cell: (l) => <span className="mc-meta">{l.channel.source} / {l.channel.campaign}{l.landing ? <><br />{l.landing}</> : null}</span> },
          { header: 'Status', cell: (l) => manage ? (
            <form action={updateLead} className="mc-inline" aria-label={`Demo request from ${l.hospitalName}`}>
              <input type="hidden" name="id" value={l.id} />
              <select name="status" defaultValue={l.status} aria-label="Status">{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
              <input name="note" defaultValue={l.note ?? ''} placeholder="Note" aria-label="Note" className="mc-input-sm" maxLength={500} />
              <button className="mc-btn mc-btn-ghost">Save</button>
            </form>
          ) : <><Badge tone={STATUS[l.status]?.tone ?? 'neutral'}>{STATUS[l.status]?.label ?? l.status}</Badge>{l.note ? <div className="mc-meta">{l.note}</div> : null}</> },
        ]} />
      </Card>
    </ZoneFrame>
  );
}
