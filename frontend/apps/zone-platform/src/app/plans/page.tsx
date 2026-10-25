import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { createPlan, newVersion } from '@/lib/actions';
import { get, inr, type PlanSummary, STATUS } from '@/lib/console';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** Every plan and its versions; build a new plan or the next version of one. */
export default async function Plans({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('platform', '/platform/plans');
  const [plans, editions] = await Promise.all([get<PlanSummary[]>('/plans'), get<{ code: string; name: string }[]>('/editions')]);
  const canEdit = can(caps, 'catalog:edit:tenant');
  return (
    <ZoneFrame zone="platform" path="/platform/plans" zones={ZONES}>
      <PageHeader title="Plans" subtitle="What MediCare sells. A published version never changes: edit by building the next version; hospitals stay on theirs until moved." />
      <Flash {...await searchParams} />
      <Card title="All plans">
        <Table rows={plans} empty="No plans." columns={[
          { header: 'Plan', cell: (p) => <><strong>{p.name}</strong>{p.internal ? <> <Badge>internal</Badge></> : null}<div className="mc-meta">{p.code} · {p.editionName} · {p.tier}</div></> },
          { header: 'Versions', cell: (p) => (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
              {p.versions.map((v) => (
                <li key={v.id}><a href={`/platform/plans/versions/${v.id}`}>v{v.version}</a> <Badge tone={STATUS[v.status].tone}>{STATUS[v.status].label}</Badge> <span className="mc-meta">{inr(v.listPrice)}/month{v.hospitals ? ` · ${v.hospitals} hospital${v.hospitals > 1 ? 's' : ''}` : ''}</span></li>
              ))}
            </ul>
          ) },
          { header: '', cell: (p) => (canEdit && !p.internal && !p.versions.some((v) => v.status === 'DRAFT' || v.status === 'PENDING') ? (
            <form action={newVersion} aria-label={`New version of ${p.code}`}><input type="hidden" name="plan" value={p.code} /><Button variant="ghost">New version</Button></form>
          ) : null) },
        ]} />
      </Card>
      {canEdit ? (
        <Card title="New plan">
          <form action={createPlan} className="mc-form" aria-label="New plan">
            <Field label="Name" name="name" required placeholder="Diagnostic Center – Professional" />
            <Field label="Code" name="code" required placeholder="DIAG_CENTER_PRO" hint="CAPITALS_AND_UNDERSCORES; used by sales and the API" pattern="[A-Za-z][A-Za-z0-9_]{2,39}" />
            <label className="mc-field"><span>Edition</span>
              <select name="edition" required>{editions.map((e) => <option key={e.code} value={e.code}>{e.name}</option>)}</select>
            </label>
            <Field label="Tier" name="tier" required placeholder="Professional" />
            <label className="mc-field"><span>Start from</span>
              <select name="copyFrom" defaultValue="">
                <option value="">Nothing (core only)</option>
                {plans.filter((p) => !p.internal).map((p) => <option key={p.code} value={p.code}>Copy of {p.name}</option>)}
              </select>
            </label>
            <Field label="Description" name="description" placeholder="For pathology labs with home collection" />
            <Button>Create draft</Button>
          </form>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
