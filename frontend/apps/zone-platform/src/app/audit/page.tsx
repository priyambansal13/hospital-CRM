import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Card, PageHeader, Table } from '@mc/ui';
import { type AuditEntry, get, when } from '@/lib/console';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const short = (x: unknown) => (x == null ? '' : JSON.stringify(x).slice(0, 160));

/** Every packaging and contract change: who, what, before and after. */
export default async function Audit() {
  await zoneCapabilities('platform', '/platform/audit');
  const rows = await get<AuditEntry[]>('/audit?limit=200');
  return (
    <ZoneFrame zone="platform" path="/platform/audit" zones={ZONES}>
      <PageHeader title="Audit" subtitle="Plans, editions and hospital contracts: every change, newest first." />
      <Card>
        <Table rows={rows} empty="Nothing yet." columns={[
          { header: 'When', cell: (a) => <span className="mc-meta">{when(a.at)}</span> },
          { header: 'Who', cell: (a) => a.actor },
          { header: 'What', cell: (a) => <><strong>{a.action.toLowerCase().replaceAll('_', ' ')}</strong> {a.target.label ?? a.target.id}{a.note ? <div className="mc-meta">{a.note}</div> : null}</> },
          { header: 'Change', cell: (a) => <span className="mc-meta" style={{ wordBreak: 'break-word' }}>{a.before ? <>before {short(a.before)}<br /></> : null}{a.after ? <>after {short(a.after)}</> : null}</span> },
        ]} />
      </Card>
    </ZoneFrame>
  );
}
