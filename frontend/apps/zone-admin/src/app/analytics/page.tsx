import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, hasFeature, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Bars, Card, Columns, Kpi, PageHeader, Table } from '@mc/ui';
import { ZONES } from '@/lib/zones';
import { fmt, type MetricResult, periodOf, PERIODS, type Unit } from './lib';

export const dynamic = 'force-dynamic';

interface Kpi { metric: string; label: string; unit: Unit; better: 'up' | 'down'; value: number | null; previous: number | null }
interface Summary { from: string; to: string; kpis: Kpi[]; asOf: { lastEventAt: string | null; loads: { source: string; status: string; rows: number; error: string | null }[] } }
interface Catalog { metrics: { key: string; label: string; description: string; unit: Unit; dimensions: string[] }[]; dimensions: { key: string; label: string }[] }
interface Branch { id: string; name: string; active?: boolean }

const ICON: Record<string, string> = { appointments: 'calendar', completed_visits: 'stethoscope', no_show_rate: 'clock', cancellation_rate: 'alert', utilisation: 'chart', revenue: 'receipt', lab_orders: 'flask', lab_tat_hours: 'clock', new_patients: 'users' };
const soft = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

function change(k: Kpi) {
  if (k.value == null || k.previous == null) return { text: 'No earlier figure', tone: undefined };
  const d = Math.round((k.value - k.previous) * 10) / 10;
  if (d === 0) return { text: 'Same as the period before', tone: undefined };
  const good = (d > 0) === (k.better === 'up');
  const by = k.unit === 'percent' ? `${Math.abs(d)} points` : fmt(Math.abs(d), k.unit);
  return { text: `${d > 0 ? '▲' : '▼'} ${by} vs. the period before (${fmt(k.previous, k.unit)})`, tone: good ? ('success' as const) : ('warning' as const) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-10-31 → "31" (the 1st of a month and weeks: "1 Nov") so a month of columns fits. */
const short = (label: string) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(label);
  if (!m) return label;
  return m[2] === '01' ? `1 ${MONTHS[Number(m[1]) - 1]}` : String(Number(m[2]));
};

function Chart({ r, columns }: { r: MetricResult | null; columns?: boolean }) {
  if (!r) return <p className="mc-empty">Not available.</p>;
  const rows = r.rows.filter((x) => x.value != null) as { label: string; value: number }[];
  if (!rows.length || rows.every((x) => x.value === 0)) return <p className="mc-empty">No data for this period.</p>;
  return columns
    ? <Columns rows={r.rows.map((x) => ({ label: short(x.label), value: x.value ?? 0 }))} />
    : <Bars rows={rows.map((x) => ({ label: x.label, value: x.value, display: fmt(x.value, r.unit) }))} max={r.unit === 'percent' ? 100 : undefined} />;
}

/** Admin: the hospital's numbers from the analytics warehouse (de-identified), for the branches the person manages. */
export default async function Analytics({ searchParams }: { searchParams: Promise<{ period?: string; branch?: string; metric?: string; by?: string }> }) {
  const caps = await zoneCapabilities('admin', '/admin/analytics');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const period = periodOf(sp.period);
  const branch = sp.branch && /^[0-9a-f-]{36}$/i.test(sp.branch) ? sp.branch : undefined;
  const filters = branch ? { branchId: branch } : {};
  const q = (metric: string, groupBy?: string, limit = 12) => soft(api<MetricResult>('/api/analytics/v1/analytics/query', { token, method: 'POST', body: { metric, from: period.from, to: period.to, groupBy, filters, limit } }));
  const long = period.days > 62;
  const [summary, catalog, branches, trend, weekday, specialty, channels, money, util, tat] = await Promise.all([
    api<Summary>(`/api/analytics/v1/analytics/summary?from=${period.from}&to=${period.to}${branch ? `&branchId=${branch}` : ''}`, { token }),
    api<Catalog>('/api/analytics/v1/analytics/catalog', { token }),
    can(caps, 'branch:read:tenant') ? soft(api<Branch[]>('/api/tenant/v1/branches', { token })) : null,
    q('appointments', long ? 'week' : 'day', 100),
    q('no_show_rate', 'weekday'),
    q('appointments', 'specialty', 8),
    q('appointments', 'source'),
    q('revenue', branch ? 'paid_for' : 'branch'),
    q('utilisation', 'doctor', 8),
    q('lab_tat_hours', long ? 'month' : 'week'),
  ]);
  const metric = catalog.metrics.find((m) => m.key === sp.metric);
  const by = metric && sp.by && metric.dimensions.includes(sp.by) ? sp.by : undefined;
  const explored = metric ? await q(metric.key, by, 100) : null;
  const exportable = hasFeature(caps, 'analytics.export');
  const qs = (o: Record<string, string | undefined>) => `?${new URLSearchParams(Object.entries({ period: period.key, branch, ...o }).filter(([, v]) => v) as [string, string][])}`;
  const loading = summary.asOf.loads.filter((l) => l.status !== 'DONE');

  return (
    <ZoneFrame zone="admin" path="/admin/analytics" zones={ZONES} wide>
      <PageHeader
        title="Analytics"
        subtitle={`${period.label} (${period.from} to ${period.to}). Patient details never reach these reports: counts only.`}
        actions={<form className="mc-inline" method="get">
          <input type="hidden" name="period" value={period.key} />
          {branches?.length ? (
            <select className="mc-select-sm" name="branch" defaultValue={branch ?? ''} aria-label="Branch">
              <option value="">All branches</option>
              {branches.filter((b) => b.active !== false).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : null}
          {branches?.length ? <button className="mc-btn mc-btn-ghost">Show</button> : null}
        </form>}
      />
      <nav className="mc-chips" aria-label="Period" style={{ marginBottom: 16 }}>
        {PERIODS.map((p) => <a key={p.key} className={`mc-chip${p.key === period.key ? ' active' : ''}`} aria-current={p.key === period.key ? 'page' : undefined} href={qs({ period: p.key })}>{p.label}</a>)}
      </nav>
      {loading.length ? <div className="mc-alert mc-alert-info" role="status">The warehouse is still loading earlier records ({loading.map((l) => `${l.source.replace('_', ' ')}: ${l.status.toLowerCase()}`).join(', ')}). Numbers will fill in shortly.</div> : null}

      <div className="mc-kpis">
        {summary.kpis.map((k) => {
          const c = change(k);
          return <Kpi key={k.metric} label={k.label} icon={ICON[k.metric] ?? 'chart'} value={fmt(k.value, k.unit)} sub={c.text} tone={c.tone} href={qs({ metric: k.metric, by: k.unit === 'inr' ? 'day' : 'weekday' }) + '#explore'} />;
        })}
      </div>

      <div className="mc-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <div style={{ gridColumn: '1 / -1' }}><Card title={`Appointments by ${long ? 'week starting' : 'day'}`}><Chart r={trend} columns /></Card></div>
        <Card title="No-show rate by day of the week"><Chart r={weekday} /></Card>
        <Card title="Busiest departments"><Chart r={specialty} /></Card>
        <Card title="How patients booked"><Chart r={channels} /></Card>
        <Card title={branch ? 'Revenue by what was paid for' : 'Revenue by branch'}><Chart r={money} /></Card>
        <Card title="Doctors' utilisation (booked share of their time)"><Chart r={util} /></Card>
        <Card title={`Lab turnaround by ${long ? 'month' : 'week'} (median hours)`}><Chart r={tat} /></Card>
      </div>

      <section id="explore">
        <Card title="Explore a metric">
          <form className="mc-inline" method="get" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
            <input type="hidden" name="period" value={period.key} />
            {branch ? <input type="hidden" name="branch" value={branch} /> : null}
            <select className="mc-select-sm" name="metric" defaultValue={metric?.key ?? ''} aria-label="Metric" required>
              <option value="" disabled>Choose a metric</option>
              {catalog.metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
            <select className="mc-select-sm" name="by" defaultValue={by ?? ''} aria-label="Split by">
              <option value="">Total only</option>
              {catalog.dimensions.map((d) => <option key={d.key} value={d.key}>by {d.label.toLowerCase()}</option>)}
            </select>
            <button className="mc-btn mc-btn-primary">Show</button>
          </form>
          {metric ? <p className="mc-meta">{metric.description}.{sp.by && !by ? ` It cannot be split that way: try ${metric.dimensions.join(', ')}.` : ''}</p> : <p className="mc-meta">Pick a metric and how to split it. Every number here comes from the same definitions the Ops agent uses.</p>}
          {explored ? (
            explored.groupBy ? (
              <>
                <Chart r={explored} />
                <Table rows={explored.rows} empty="No data for this period." columns={[{ header: explored.groupLabel ?? '', cell: (r) => r.label }, { header: explored.label, cell: (r) => fmt(r.value, explored.unit) }]} />
              </>
            ) : <p className="mc-kpi-value" style={{ margin: '8px 0' }}>{fmt(explored.value, explored.unit)}</p>
          ) : metric ? <p className="mc-empty">This metric is not available for your branches.</p> : null}
          {explored && exportable ? <p style={{ marginBottom: 0 }}><a className="mc-btn mc-btn-ghost" href={`/admin/analytics/export${qs({ metric: metric!.key, by })}`}>Download CSV</a></p> : null}
          {explored && !exportable ? <p className="mc-meta" style={{ marginBottom: 0 }}>CSV downloads are part of advanced analytics in higher plans.</p> : null}
        </Card>
      </section>
      <p className="mc-meta">
        {summary.asOf.lastEventAt ? `Up to date to ${new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(summary.asOf.lastEventAt))}. ` : ''}
        Dates are each branch&apos;s own calendar day; money is counted on the day it moved.
      </p>
    </ZoneFrame>
  );
}
