import { api, ApiError } from '@mc/bff';
import { supportAction } from '@/lib/support-actions';
import { reactivateHospital } from '@/lib/reactivate-actions';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, PageHeader, Table } from '@mc/ui';
import { notFound } from 'next/navigation';
import { assignPlan, overrideFeature, overrideModule, recordOfflinePayment } from '@/lib/actions';
import { type Addon, get, type HospitalDetail, inr, limitText, P, type PlanSummary, type RegistryModule, type Simulation, STATUS, token, when } from '@/lib/console';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Billing {
  status: string; periodStart: string | null; periodEnd: string | null; trialEndsAt: string | null; graceEndsAt: string | null; clockOffsetDays: number;
  paymentMethod: { kind: string; brand: string | null; last4: string | null } | null; coupon: { code: string } | null; pendingChange: { plan: string } | null;
  unpaid: { invoices: number; total: number };
  invoices: { id: string; number: string; kind: string; status: string; total: number; issuedAt: string; lastError: string | null }[];
}
const BILL_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { ACTIVE: 'success', TRIALING: 'neutral', PAST_DUE: 'warning', GRACE: 'danger', SUSPENDED: 'danger', CANCELLED: 'neutral', EXPIRED: 'neutral' };
const SOURCE: Record<string, string> = { PLAN: 'plan', ADDON: 'add-on', OVERRIDE: 'override', TRIAL: 'trial' };
const STATE_TONE: Record<string, 'success' | 'warning' | 'neutral'> = { ACTIVE: 'success', ACTIVATING: 'warning', DISABLING: 'warning', READ_ONLY: 'neutral' };

/** One hospital: its contract and modules; move it to a plan (after simulating it), overrides, history, audit. */
export default async function HospitalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string; simulate?: string; addons?: string }> }) {
  const { id } = await params;
  const path = `/platform/hospitals/${id}`;
  const caps = await zoneCapabilities('platform', path);
  const sp = await searchParams;
  const [h, registry, plans, addons, { billing }] = await Promise.all([
    get<HospitalDetail>(`/hospitals/${encodeURIComponent(id)}`).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e))),
    get<RegistryModule[]>('/registry'),
    get<PlanSummary[]>('/plans'),
    get<Addon[]>('/addons'),
    get<{ billing: Billing | null }>(`/hospitals/${encodeURIComponent(id)}/billing`).catch(() => ({ billing: null })),
  ]);
  const manage = can(caps, 'customer:manage:tenant') && !h.plan?.internal;
  const names = new Map<string, string>([...registry.map((m) => [m.key, m.name] as const), ...registry.flatMap((m) => m.features.map((f) => [f.key, f.name] as const))]);
  const units = new Map(registry.flatMap((m) => m.features.map((f) => [f.key, f.unit] as const)));
  const sellable = plans.filter((p) => !p.internal);
  const published = sellable.flatMap((p) => p.versions.filter((v) => v.status === 'PUBLISHED').map((v) => ({ ...v, plan: p })));
  const simulatable = sellable.flatMap((p) => p.versions.filter((v) => v.status !== 'RETIRED').map((v) => ({ ...v, plan: p })));
  const c = h.contract;
  const states = new Map((h.moduleStates ?? []).map((s) => [s.module_key, s]));
  const simAddons = (sp.addons ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean).map((code) => ({ code }));
  const { sim, simError } = sp.simulate
    ? await api<Simulation>(`${P}/hospitals/${id}/simulate`, { token: await token(), body: { versionId: sp.simulate, addons: simAddons } })
      .then((r) => ({ sim: r as Simulation | null, simError: null as string | null }))
      .catch((e) => ({ sim: null, simError: e instanceof ApiError ? e.message : 'simulation failed' }))
    : { sim: null, simError: null };
  const limits = registry.flatMap((m) => m.features.filter((f) => f.type === 'LIMIT' && c?.effective.features[f.key]).map((f) => ({ ...f, value: c!.effective.features[f.key], override: c!.overrides.features?.[f.key] })));

  return (
    <ZoneFrame zone="platform" path={path} zones={ZONES}>
      <PageHeader title={h.slug} subtitle={c ? `${c.plan.name} v${c.plan.version} since ${when(c.since)}` : 'No plan yet'} actions={<a className="mc-btn mc-btn-ghost" href="/platform">All hospitals</a>} />
      <Flash ok={sp.ok} error={sp.error} />
      {h.plan?.internal ? <Alert tone="info">MediCare&apos;s own account (platform console). Its plan is managed with the CLI.</Alert> : null}
      {c ? (
        <Card title="Contract">
          <dl className="mc-dl">
            <dt>Plan</dt><dd><strong>{c.plan.name}</strong> v{c.plan.version} · {c.plan.editionName} · {inr(c.plan.listPrice)}/month{h.plan?.versionStatus === 'RETIRED' ? <> <Badge>{STATUS.RETIRED.label} version</Badge></> : null}</dd>
            <dt>Add-ons</dt><dd>{c.addons.length ? c.addons.map((a) => `${a.name}${a.quantity > 1 ? ` × ${a.quantity}` : ''}`).join(', ') : 'None'}</dd>
            <dt>Overrides</dt><dd>{[...Object.entries(c.overrides.modules ?? {}).map(([k, on]) => `${names.get(k) ?? k} ${on ? 'on' : 'off'}`), ...Object.entries(c.overrides.features ?? {}).map(([k, x]) => `${names.get(k) ?? k}: ${x.limit ?? 'unlimited'}`)].join(', ') || 'None'}</dd>
            <dt>Last change</dt><dd>{c.reason} <span className="mc-meta">by {c.by}</span></dd>
          </dl>
        </Card>
      ) : null}
      {billing ? (
        <Card title="Billing">
          <p style={{ marginTop: 0 }}><Badge tone={BILL_TONE[billing.status] ?? 'neutral'}>{billing.status.toLowerCase().replace('_', ' ')}</Badge>
            {' '}{billing.paymentMethod?.kind === 'CARD' ? `${billing.paymentMethod.brand} ••${billing.paymentMethod.last4}` : billing.paymentMethod?.kind === 'OFFLINE' ? 'pays by bank transfer' : 'no payment method'}
            {billing.periodEnd ? <span className="mc-meta"> · renews {when(billing.periodEnd)}</span> : billing.trialEndsAt ? <span className="mc-meta"> · trial until {when(billing.trialEndsAt)}</span> : null}
            {billing.coupon ? <span className="mc-meta"> · coupon {billing.coupon.code}</span> : null}{billing.pendingChange ? <span className="mc-meta"> · moving to {billing.pendingChange.plan} at period end</span> : null}
            {billing.clockOffsetDays ? <span className="mc-meta"> · test clock +{billing.clockOffsetDays} days</span> : null}</p>
          {manage && ['EXPIRED', 'CANCELLED'].includes(billing.status) ? (
            // D-7: bring the hospital back (card on file, or bank transfer)
            <form action={reactivateHospital} className="mc-inline" aria-label="Reactivate" style={{ marginBottom: 12 }}>
              <input type="hidden" name="hospitalId" value={h.id} />
              <input name="reason" required minLength={5} placeholder="Why (e.g. paid by transfer, ticket 1234)" aria-label="Reason" className="mc-input-sm" />
              <label className="mc-check"><input type="checkbox" name="offline" defaultChecked={billing.paymentMethod?.kind !== 'CARD'} /> <span>by bank transfer</span></label>
              <button className="mc-btn mc-btn-primary">Reactivate</button>
            </form>
          ) : null}
          <Table rows={billing.invoices.slice(0, 10)} empty="No invoices yet." columns={[
            { header: 'Invoice', cell: (i) => <>{i.number} <span className="mc-meta">{i.kind.toLowerCase()}</span></> },
            { header: 'Issued', cell: (i) => when(i.issuedAt) },
            { header: 'Total', cell: (i) => inr(i.total) },
            { header: 'Status', cell: (i) => <>{i.status.toLowerCase()}{i.lastError && i.status !== 'PAID' ? <div className="mc-meta">{i.lastError}</div> : null}</> },
            { header: '', cell: (i) => (manage && (i.status === 'OPEN' || i.status === 'FAILED') ? (
              <form action={recordOfflinePayment} className="mc-inline" aria-label={`Record payment for ${i.number}`}>
                <input type="hidden" name="hospitalId" value={h.id} /><input type="hidden" name="invoiceId" value={i.id} />
                <input name="reference" required minLength={3} placeholder="UTR / NEFT ref" aria-label="Bank reference" className="mc-input-sm" style={{ width: 140 }} />
                <button className="mc-btn mc-btn-ghost">Paid</button>
              </form>
            ) : null) },
          ]} />
        </Card>
      ) : null}
      {c ? (
        <Card title="Modules">
          <Table rows={c.effective.modules} empty="" columns={[
            { header: 'Module', cell: (m) => <strong>{names.get(m.key) ?? m.key}</strong> },
            { header: 'From', cell: (m) => SOURCE[m.source] ?? m.source },
            { header: 'State', cell: (m) => { const s = states.get(m.key); return s ? <><Badge tone={STATE_TONE[s.state] ?? 'neutral'}>{s.state.toLowerCase().replace('_', ' ')}</Badge>{s.last_error ? <span className="mc-meta"> retry {s.attempts}: {s.last_error}</span> : null}</> : '—'; } },
          ]} />
          {[...states.values()].filter((s) => s.state === 'READ_ONLY').length ? <p className="mc-meta" style={{ marginBottom: 0 }}>Read only (no longer in the plan): {[...states.values()].filter((s) => s.state === 'READ_ONLY').map((s) => names.get(s.module_key) ?? s.module_key).join(', ')}</p> : null}
        </Card>
      ) : null}
      {c ? (
        <Card title="Limits">
          <Table rows={limits} empty="No limits." columns={[
            { header: 'What', cell: (f) => f.name },
            { header: 'Allowed', cell: (f) => <>{limitText(f.value, f.unit)}{f.override ? <> <Badge tone="warning">override</Badge></> : null}</> },
            { header: '', cell: (f) => (manage ? (
              <form action={overrideFeature} className="mc-inline" aria-label={`Override ${f.name}`}>
                <input type="hidden" name="hospitalId" value={h.id} /><input type="hidden" name="feature" value={f.key} />
                <input name="limit" type="number" min={0} placeholder="unlimited" aria-label={`${f.name} limit`} className="mc-input-sm" style={{ width: 100 }} />
                <input name="reason" required minLength={3} placeholder="reason" aria-label="Reason" className="mc-input-sm" style={{ width: 160 }} />
                <button className="mc-btn mc-btn-ghost">Set</button>
                {f.override ? <button className="mc-btn mc-btn-ghost" name="reset" value="1">Back to plan</button> : null}
              </form>
            ) : null) },
          ]} />
        </Card>
      ) : null}

      <Card title="Simulate a plan">
        <form method="get" className="mc-inline" aria-label="Simulate">
          <select name="simulate" aria-label="Plan version" defaultValue={sp.simulate ?? ''} required>
            <option value="" disabled>Choose a plan…</option>
            {simulatable.map((v) => <option key={v.id} value={v.id}>{v.plan.name} v{v.version}{v.status !== 'PUBLISHED' ? ` (${STATUS[v.status].label})` : ''}</option>)}
          </select>
          <input name="addons" placeholder="add-ons, e.g. LAB,BRANCHES_5" defaultValue={sp.addons ?? ''} aria-label="Add-ons" className="mc-input-sm" />
          <button className="mc-btn mc-btn-ghost">Simulate</button>
        </form>
        {simError ? <Alert tone="error">{simError}</Alert> : null}
        {sim ? (
          <div role="region" aria-label="Simulation" style={{ marginTop: 12 }}>
            <p style={{ marginTop: 0 }}>On <strong>{sim.plan.name} v{sim.plan.version}</strong>: {inr(sim.currentPrice)} → <strong>{inr(sim.price)}</strong>/month. Overrides kept.</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {sim.diff.modulesAdded.map((m) => <li key={m}><Badge tone="success">gains</Badge> {names.get(m) ?? m}</li>)}
              {sim.diff.modulesRemoved.map((m) => <li key={m}><Badge tone="danger">loses</Badge> {names.get(m) ?? m} (becomes read-only)</li>)}
              {sim.diff.features.filter((f) => f.before && f.after).map((f) => <li key={f.key}>{names.get(f.key) ?? f.key}: {limitText(f.before, units.get(f.key))} → <strong>{limitText(f.after, units.get(f.key))}</strong></li>)}
              {!sim.diff.modulesAdded.length && !sim.diff.modulesRemoved.length && !sim.diff.features.length ? <li>No change in modules or limits.</li> : null}
            </ul>
            {sim.problems.length ? <Alert tone="error">{sim.problems.join('; ')}</Alert> : null}
          </div>
        ) : null}
      </Card>

      {manage ? (
        <Card title="Move to a plan">
          <form action={assignPlan} className="mc-form" aria-label="Move to a plan">
            <input type="hidden" name="hospitalId" value={h.id} />
            <label className="mc-field"><span>Plan</span>
              <select name="plan" required defaultValue="">
                <option value="" disabled>Choose…</option>
                {published.map((v) => <option key={v.id} value={v.plan.code}>{v.plan.name} (v{v.version}, {inr(v.listPrice)}/month)</option>)}
              </select>
            </label>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="mc-meta">Add-ons (only those sold with the chosen plan are accepted)</legend>
              {addons.map((a) => <label key={a.code} className="mc-check"><input type="checkbox" name="addon" value={a.code} defaultChecked={c?.addons.some((x) => x.code === a.code)} /> <span>{a.name} <span className="mc-meta">{inr(a.listPrice)}/month</span></span></label>)}
            </fieldset>
            <label className="mc-field"><span>Reason</span><input name="reason" required minLength={3} maxLength={300} placeholder="Signed order form #1234" /></label>
            <Button>Move now</Button>
          </form>
          <p className="mc-meta" style={{ marginBottom: 0 }}>Applies immediately: added modules switch on, removed ones become read-only (no data is deleted).</p>
        </Card>
      ) : null}

      {manage && c ? (
        <Card title="Switch one module (override)">
          <form action={overrideModule} className="mc-inline" aria-label="Module override">
            <input type="hidden" name="hospitalId" value={h.id} />
            <select name="module" aria-label="Module" required>{registry.filter((m) => !m.internal && !m.alwaysOn).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
            <select name="state" aria-label="State"><option value="on">on</option><option value="off">off</option><option value="plan">as the plan says</option></select>
            <input name="reason" required minLength={3} placeholder="reason (pilot, support case…)" aria-label="Reason" className="mc-input-sm" style={{ width: 220 }} />
            <button className="mc-btn mc-btn-ghost">Save</button>
          </form>
        </Card>
      ) : null}

      <Card title="Plan history">
        <Table rows={h.history.slice(0, 15)} empty="No contracts." columns={[
          { header: 'Plan', cell: (x) => `${x.plan} v${x.version}` },
          { header: 'From', cell: (x) => when(x.startsAt) },
          { header: 'Until', cell: (x) => (x.endedAt ? when(x.endedAt) : <Badge tone="success">current</Badge>) },
          { header: 'By', cell: (x) => <>{x.by}<div className="mc-meta">{x.reason}</div></> },
        ]} />
        {h.history.length > 15 ? <p className="mc-meta" style={{ marginBottom: 0 }}>{h.history.length - 15} earlier changes (all of them are in the audit log).</p> : null}
      </Card>
      <Card title="Audit">
        <Table rows={h.audit} empty="Nothing yet." columns={[
          { header: 'When', cell: (a) => when(a.at) },
          { header: 'Who', cell: (a) => a.actor },
          { header: 'What', cell: (a) => <>{a.action.toLowerCase().replaceAll('_', ' ')}{a.note ? <div className="mc-meta">{a.note}</div> : null}</> },
        ]} />
      </Card>
      {manage ? (
        // support actions (review H-7); each needs a reason, kept in the platform audit log
        <Card title="Support actions">
          {billing?.status === 'TRIALING' ? (
            <form action={supportAction} className="mc-inline" aria-label="Extend trial" style={{ marginBottom: 12 }}>
              <input type="hidden" name="hospitalId" value={h.id} /><input type="hidden" name="op" value="trial" />
              <input name="days" type="number" min={1} max={60} defaultValue={14} aria-label="Days" className="mc-input-sm" style={{ width: 70 }} />
              <input name="reason" required minLength={5} placeholder="Why" aria-label="Reason" className="mc-input-sm" />
              <button className="mc-btn mc-btn-ghost">Extend trial</button>
            </form>
          ) : null}
          <form action={supportAction} className="mc-inline" aria-label="Credit note" style={{ marginBottom: 12 }}>
            <input type="hidden" name="hospitalId" value={h.id} /><input type="hidden" name="op" value="credit" />
            <input name="amount" type="number" min={1} step="0.01" required placeholder="₹" aria-label="Amount" className="mc-input-sm" style={{ width: 90 }} />
            <input name="reason" required minLength={5} placeholder="Why (e.g. outage on 3 Nov)" aria-label="Reason" className="mc-input-sm" />
            <button className="mc-btn mc-btn-ghost">Add credit</button>
          </form>
          <form action={supportAction} className="mc-inline" aria-label="Online status" style={{ marginBottom: 12 }}>
            <input type="hidden" name="hospitalId" value={h.id} /><input type="hidden" name="op" value={h.status === 'SUSPENDED' ? 'activate' : 'suspend'} />
            <input name="reason" required minLength={5} placeholder="Why" aria-label="Reason" className="mc-input-sm" />
            <button className="mc-btn mc-btn-ghost">{h.status === 'SUSPENDED' ? 'Bring back online' : 'Take offline'}</button>
          </form>
          <form action={supportAction} className="mc-inline" aria-label="Delete hospital">
            <input type="hidden" name="hospitalId" value={h.id} /><input type="hidden" name="op" value="delete" />
            <input name="reason" required minLength={5} placeholder="Why" aria-label="Reason" className="mc-input-sm" />
            <input name="confirmSlug" required placeholder={`type ${h.slug}`} aria-label="Confirm slug" className="mc-input-sm" />
            <button className="mc-btn mc-btn-danger">Delete</button>
          </form>
          <p className="mc-meta">Deleting keeps the data for the retention period (30 days); it is then purged with <code>mc tenant purge</code>.</p>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
