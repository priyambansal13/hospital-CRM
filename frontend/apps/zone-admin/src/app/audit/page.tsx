import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, Chip, Field, PageHeader, Table } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Entry { id: string; occurredAt: string; source: string; actor: { id: string; kind: string; name: string | null }; action: string; resourceType: string; resourceId: string | null; patientId: string | null; purpose: string; changes: string[] | null }
interface Page { items: Entry[]; nextBefore: number | null; breakGlassLast7Days: number }

const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
const ACTIONS = ['READ', 'CREATE', 'UPDATE', 'DELETE', 'SIGN', 'AMEND', 'EXPORT', 'BREAK_GLASS', 'LOOKUP', 'DENIED'];

/** Who did what to which patient record; break-glass highlighted; tamper check of the whole log. */
export default async function Audit({ searchParams }: { searchParams: Promise<{ mrn?: string; patientId?: string; action?: string; purpose?: string; before?: string; verify?: string }> }) {
  await zoneCapabilities('admin', '/admin/audit');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  let patientId = sp.patientId;
  let mrnError: string | null = null;
  if (sp.mrn && !patientId) {
    const found = await api<{ id: string; mrn: string }[]>(`/api/patient/v1/desk/patients?q=${encodeURIComponent(sp.mrn)}`, { token }).catch((e) => (e instanceof ApiError ? [] : Promise.reject(e)));
    patientId = found.find((p) => p.mrn.toUpperCase() === sp.mrn!.trim().toUpperCase())?.id;
    if (!patientId) mrnError = `No patient with MRN ${sp.mrn}`;
  }
  const qs = new URLSearchParams(Object.entries({ patientId, action: sp.action, purpose: sp.purpose, before: sp.before }).filter(([, v]) => v) as [string, string][]);
  const page = mrnError ? { items: [], nextBefore: null, breakGlassLast7Days: 0 } : await api<Page>(`/api/audit/v1/audit?${qs}`, { token });
  const verify = sp.verify ? await api<{ ok: boolean; checked: number; firstBrokenId: string | null; problem: string | null }>('/api/audit/v1/audit/verify', { token }) : null;
  const link = (q: Record<string, string | undefined>) => `/admin/audit?${new URLSearchParams(Object.entries({ mrn: sp.mrn, action: sp.action, purpose: sp.purpose, ...q }).filter(([, v]) => v) as [string, string][])}`;
  return (
    <ZoneFrame zone="admin" path="/admin/audit" zones={ZONES}>
      <PageHeader title="Audit log" subtitle="Every read and change of patient records, and every change to the hospital's configuration. Entries cannot be edited or deleted." actions={<a className="mc-btn mc-btn-ghost" href={link({ verify: '1' })}>Verify the chain</a>} />
      {verify ? (verify.ok
        ? <Alert tone="success">Audit chain intact: {verify.checked} entries checked, none changed or missing.</Alert>
        : <Alert tone="error">Audit chain BROKEN at entry {verify.firstBrokenId}: {verify.problem}. Escalate to security.</Alert>) : null}
      {page.breakGlassLast7Days ? <Alert tone="error">{page.breakGlassLast7Days} emergency access (break-glass) event(s) in the last 7 days. <a href={link({ action: 'BREAK_GLASS', purpose: undefined })}>Review</a></Alert> : null}
      {mrnError ? <Alert tone="error">{mrnError}</Alert> : null}
      <Card>
        <form method="get" className="mc-form">
          <Field label="Patient MRN" name="mrn" defaultValue={sp.mrn ?? ''} placeholder="MRN100023" />
          {sp.action ? <input type="hidden" name="action" value={sp.action} /> : null}
          <Button>Filter</Button>
        </form>
        <div className="mc-chips" style={{ marginTop: 12 }}>
          <Chip href={link({ action: undefined })} active={!sp.action}>All</Chip>
          {ACTIONS.map((a) => <Chip key={a} href={link({ action: a })} active={sp.action === a}>{a.toLowerCase().replace('_', '-')}</Chip>)}
        </div>
        <div className="mc-chips" style={{ marginTop: 8 }}>
          <Chip href={link({ purpose: undefined })} active={!sp.purpose}>Patient records and configuration</Chip>
          {/* admin actions: staff, roles, settings, prices, templates, refunds, payout account (review B-8) */}
          <Chip href={link({ purpose: 'ADMIN' })} active={sp.purpose === 'ADMIN'}>Configuration only</Chip>
        </div>
      </Card>
      <Card title="Entries">
        <Table
          rows={page.items}
          empty="No entries."
          columns={[
            { header: '#', cell: (e) => <span className="mc-meta">{e.id}</span> },
            { header: 'When', cell: (e) => when(e.occurredAt) },
            { header: 'Who', cell: (e) => <>{e.actor.name ?? e.actor.kind}<br /><span className="mc-meta">{e.actor.kind}</span></> },
            { header: 'Action', cell: (e) => <Badge tone={e.action === 'BREAK_GLASS' || e.action === 'DENIED' ? 'danger' : 'neutral'}>{e.action.toLowerCase().replace('_', '-')}</Badge> },
            { header: 'What', cell: (e) => `${e.resourceType.toLowerCase().replace('_', ' ')}${e.changes?.length ? ` (${e.changes.join(', ')})` : ''}` },
            { header: 'Purpose', cell: (e) => e.purpose.toLowerCase().replace('_', ' ') },
            { header: 'Patient', cell: (e) => (e.patientId ? <a href={`/admin/audit?patientId=${e.patientId}`} className="mc-meta">{e.patientId.slice(0, 8)}</a> : '—') },
          ]}
        />
        {page.nextBefore ? <p><a href={link({ before: String(page.nextBefore) }) + (patientId && !sp.mrn ? `&patientId=${patientId}` : '')}>Older entries</a></p> : null}
      </Card>
    </ZoneFrame>
  );
}
