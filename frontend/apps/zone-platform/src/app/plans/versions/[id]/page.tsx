import { getSession } from '@mc/auth';
import { ApiError } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, PageHeader, Table } from '@mc/ui';
import { notFound } from 'next/navigation';
import { approveVersion, discardDraft, newVersion, rejectVersion, retireVersion, saveDraft, submitVersion } from '@/lib/actions';
import { type Diff, get, type Impact, inr, limitText, type RegistryModule, STATUS, type VersionDetail, when } from '@/lib/console';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

function DiffList({ diff, names, units }: { diff: Diff; names: Map<string, string>; units: Map<string, string | undefined> }) {
  const items = [
    ...diff.modulesAdded.map((m) => <li key={`+${m}`}><Badge tone="success">adds</Badge> {names.get(m) ?? m}</li>),
    ...diff.modulesRemoved.map((m) => <li key={`-${m}`}><Badge tone="danger">removes</Badge> {names.get(m) ?? m}</li>),
    ...diff.features.filter((f) => f.before && f.after).map((f) => <li key={f.key}>{names.get(f.key) ?? f.key}: {limitText(f.before, units.get(f.key))} → <strong>{limitText(f.after, units.get(f.key))}</strong></li>),
  ];
  return items.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{items}</ul> : <span className="mc-meta">no change</span>;
}

/** The plan builder: one version of a plan. Drafts are edited here; the second person approves here. */
export default async function VersionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const path = `/platform/plans/versions/${id}`;
  const caps = await zoneCapabilities('platform', path);
  const [v, registry] = await Promise.all([
    get<VersionDetail>(`/versions/${encodeURIComponent(id)}`).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e))),
    get<RegistryModule[]>('/registry'),
  ]);
  const impact = v.status === 'PENDING' || v.status === 'DRAFT' ? await get<Impact>(`/versions/${id}/impact`) : null;
  const me = (await getSession())?.email;
  const canEdit = can(caps, 'catalog:edit:tenant');
  const canApprove = can(caps, 'catalog:approve:tenant');
  const editable = v.status === 'DRAFT' && canEdit;
  const d = v.definition;
  const included = new Set(d.modules);
  const names = new Map<string, string>([...registry.map((m) => [m.key, m.name] as const), ...registry.flatMap((m) => m.features.map((f) => [f.key, f.name] as const))]);
  const units = new Map(registry.flatMap((m) => m.features.map((f) => [f.key, f.unit] as const)));
  const offered = registry.filter((m) => !m.internal || v.plan.internal);
  const builtByMe = !!me && [v.submittedBy, v.updatedBy, v.createdBy].includes(me);
  const st = STATUS[v.status];

  return (
    <ZoneFrame zone="platform" path={path} zones={ZONES}>
      <PageHeader title={`${v.plan.name} · v${v.version}`} subtitle={`${v.plan.code} · created by ${v.createdBy}${v.updatedBy ? ` · last saved by ${v.updatedBy} ${when(v.updatedAt)}` : ''}`}
        actions={<><Badge tone={st.tone}>{st.label}</Badge><a className="mc-btn mc-btn-ghost" href="/platform/plans">All plans</a></>} />
      <Flash {...await searchParams} />
      {v.reviewNote && v.status === 'DRAFT' ? <Alert tone="error">Sent back by the approver: {v.reviewNote}</Alert> : null}
      {v.problems.length ? (
        <div role="alert" aria-label="Problems"><Alert tone="error"><strong>Fix before submitting:</strong><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{v.problems.map((p) => <li key={p}>{p}</li>)}</ul></Alert></div>
      ) : null}
      {v.status === 'PUBLISHED' ? <Alert tone="success">Published {when(v.publishedAt)} (approved by {v.approvedBy}). {v.hospitals} hospital(s) on this version. Published versions never change.</Alert> : null}
      {v.status === 'RETIRED' ? <Alert tone="info">Retired: no longer sold. {v.hospitals} hospital(s) still on it.</Alert> : null}

      <form action={saveDraft} aria-label="Plan version">
        <input type="hidden" name="versionId" value={v.id} />
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 16 }}>
          <Card title="Price">
            <div className="mc-form" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
              <label className="mc-field"><span>List price (₹ per month)</span><input name="listPrice" type="number" min={0} step="1" defaultValue={d.listPrice} required /></label>
              <label className="mc-field"><span>Free trial (days)</span><input name="trialDays" type="number" min={0} max={365} defaultValue={d.trialDays} /></label>
            </div>
          </Card>
          <Card title="Modules">
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
              {offered.map((m) => (
                <li key={m.key}>
                  <label className="mc-check">
                    <input type="checkbox" name="module" value={m.key} defaultChecked={included.has(m.key) || m.alwaysOn} disabled={m.alwaysOn} aria-label={m.name} />
                    {m.alwaysOn ? <input type="hidden" name="module" value={m.key} /> : null}
                    <span><strong>{m.name}</strong>{m.dependsOn.length ? <span className="mc-meta"> needs {m.dependsOn.map((x) => names.get(x) ?? x).join(', ')}</span> : null}{m.alwaysOn ? <span className="mc-meta"> (always on)</span> : null}</span>
                  </label>
                </li>
              ))}
            </ul>
            {editable ? <p className="mc-meta" style={{ marginBottom: 0 }}>Save after ticking a module to set its features and limits.</p> : null}
          </Card>
          <Card title="Features and limits">
            <Table rows={registry.filter((m) => included.has(m.key)).flatMap((m) => m.features.map((f) => ({ ...f, module: m.name })))} empty="The included modules have no features." columns={[
              { header: 'Feature', cell: (f) => <><input type="hidden" name="featureKey" value={f.key} /><strong>{f.name}</strong><div className="mc-meta">{f.module}</div></> },
              { header: 'Included', cell: (f) => <label className="mc-check"><input type="checkbox" name={`on:${f.key}`} defaultChecked={d.features[f.key]?.enabled ?? f.default ?? true} aria-label={`${f.name} included`} /> <span>on</span></label> },
              { header: 'Limit', cell: (f) => (f.type !== 'BOOLEAN'
                ? <label className="mc-inline"><input name={`limit:${f.key}`} type="number" min={0} defaultValue={d.features[f.key]?.limit ?? ''} placeholder="unlimited" aria-label={`${f.name} limit`} className="mc-input-sm" style={{ width: 110 }} /> <span className="mc-meta">{f.unit}{f.type === 'METERED' ? ' a month' : ''}</span></label>
                : <span className="mc-meta">—</span>) },
              { header: 'Beyond the limit', cell: (f) => (f.type === 'METERED'
                ? <select name={`overage:${f.key}`} defaultValue={d.features[f.key]?.overage ?? 'BLOCK'} aria-label={`${f.name} beyond the limit`} className="mc-select-sm">
                    <option value="BLOCK">stop</option><option value="SOFT_WARN">warn, continue</option><option value="ALLOW_BILL">bill the extra</option>
                  </select>
                : null) },
            ]} />
          </Card>
          {registry.some((m) => included.has(m.key) && m.settings.some((s) => s.planBounded)) ? (
            <Card title="Setting ranges hospitals may choose from">
              <Table rows={registry.filter((m) => included.has(m.key)).flatMap((m) => m.settings.filter((s) => s.planBounded))} empty="" columns={[
                { header: 'Setting', cell: (s) => <><input type="hidden" name="settingKey" value={s.key} /><strong>{s.name}</strong><div className="mc-meta">allowed by the product: {s.min ?? '…'}–{s.max ?? '…'}, default {String(s.default)}</div></> },
                { header: 'Min', cell: (s) => <input name={`min:${s.key}`} type="number" defaultValue={d.settings[s.key]?.min ?? ''} aria-label={`${s.name} min`} className="mc-input-sm" style={{ width: 90 }} /> },
                { header: 'Max', cell: (s) => <input name={`max:${s.key}`} type="number" defaultValue={d.settings[s.key]?.max ?? ''} aria-label={`${s.name} max`} className="mc-input-sm" style={{ width: 90 }} /> },
              ]} />
            </Card>
          ) : null}
          <Card title="Add-ons sold with this plan">
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
              {v.addons.filter((a) => !a.module || !included.has(a.module)).map((a) => (
                <li key={a.code}><label className="mc-check"><input type="checkbox" name="addon" value={a.code} defaultChecked={d.addons.includes(a.code)} aria-label={`Add-on ${a.name}`} /> <span>{a.name} <span className="mc-meta">{inr(a.listPrice)}/month · {a.module ? names.get(a.module) : `+${a.extraLimit} ${names.get(a.feature!) ?? a.feature}`}</span></span></label></li>
              ))}
            </ul>
          </Card>
          {editable ? <div><Button>Save draft</Button></div> : null}
        </fieldset>
      </form>

      {editable ? (
        <Card title="Next step">
          <div className="mc-inline" style={{ gap: 12 }}>
            <form action={submitVersion}><input type="hidden" name="versionId" value={v.id} /><Button>Submit for approval</Button></form>
            <form action={discardDraft}><input type="hidden" name="versionId" value={v.id} /><Button variant="danger">Discard draft</Button></form>
          </div>
          <p className="mc-meta" style={{ marginBottom: 0 }}>Publishing needs a second person: someone who did not build or submit this version.</p>
        </Card>
      ) : null}

      {impact ? (
        <Card title="Impact if published">
          {impact.versusPublished ? (
            <>
              <p style={{ marginTop: 0 }}>Compared with v{impact.versusPublished.version} (published): price {inr(impact.versusPublished.price.before)} → <strong>{inr(impact.versusPublished.price.after)}</strong>/month</p>
              <DiffList diff={impact.versusPublished} names={names} units={units} />
            </>
          ) : <p style={{ marginTop: 0 }}>A new plan: no hospital is on it yet.</p>}
          {impact.hospitals.length ? (
            <>
              <p><strong>{impact.summary.hospitals}</strong> hospital(s) on older versions{impact.summary.losingModules ? <>, <strong>{impact.summary.losingModules}</strong> would lose a module</> : null}{impact.summary.withProblems ? <>, <strong>{impact.summary.withProblems}</strong> with problems</> : null}. They stay on their version unless moved now.</p>
              <Table rows={impact.hospitals} empty="" columns={[
                { header: 'Hospital', cell: (h) => <><a href={`/platform/hospitals/${h.tenantId}`}>{h.slug}</a> <span className="mc-meta">v{h.fromVersion}</span></> },
                { header: 'If moved', cell: (h) => <DiffList diff={h.diff} names={names} units={units} /> },
                { header: 'Price', cell: (h) => `${inr(h.price.before)} → ${inr(h.price.after)}` },
                { header: 'Problems', cell: (h) => [...h.problems, ...h.droppedAddons.map((a) => `add-on ${a} not sold with it`)].join('; ') || '—' },
              ]} />
            </>
          ) : null}
        </Card>
      ) : null}

      {v.status === 'PENDING' ? (
        <Card title="Approval">
          <p style={{ marginTop: 0 }}>Submitted by <strong>{v.submittedBy}</strong> {when(v.submittedAt)}.</p>
          {!canApprove ? <p className="mc-meta">Waiting for a plan approver.</p>
            : builtByMe ? <Alert tone="info">You built or submitted this version: another approver must publish it.</Alert>
            : (
              <div style={{ display: 'grid', gap: 16 }}>
                <form action={approveVersion} className="mc-form" aria-label="Approve">
                  <input type="hidden" name="versionId" value={v.id} />
                  <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="mc-meta">Hospitals on older versions</legend>
                    <label className="mc-check"><input type="radio" name="migration" value="NEW_ONLY" defaultChecked /> <span>Keep them on their version (new customers get this one)</span></label>
                    <label className="mc-check"><input type="radio" name="migration" value="MIGRATE_NOW" /> <span>Move them to this version now</span></label>
                  </fieldset>
                  <label className="mc-field"><span>Note (optional)</span><input name="note" maxLength={300} /></label>
                  <Button>Approve and publish</Button>
                </form>
                <form action={rejectVersion} className="mc-form" aria-label="Send back">
                  <input type="hidden" name="versionId" value={v.id} />
                  <label className="mc-field"><span>What needs changing</span><input name="note" required minLength={3} maxLength={300} /></label>
                  <Button variant="ghost">Send back to draft</Button>
                </form>
              </div>
            )}
        </Card>
      ) : null}

      {v.status === 'PUBLISHED' && !v.plan.internal ? (
        <Card title="Changes">
          <div className="mc-inline" style={{ gap: 12 }}>
            {canEdit ? <form action={newVersion}><input type="hidden" name="plan" value={v.plan.code} /><Button>Build the next version</Button></form> : null}
            {canApprove ? <form action={retireVersion}><input type="hidden" name="versionId" value={v.id} /><Button variant="danger">Retire (stop selling)</Button></form> : null}
          </div>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
