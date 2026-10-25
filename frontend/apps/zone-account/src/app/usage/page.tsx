import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Card, PageHeader, Table } from '@mc/ui';
import { get, type Meter } from '@/lib/account';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const RULE = { BLOCK: 'stops at the limit', SOFT_WARN: 'continues (warning only)', ALLOW_BILL: 'continues; extra billed next month' } as const;

/** Metered usage this month against the plan's allowance (80% and 100% also e-mail the account owner). */
export default async function Usage() {
  await zoneCapabilities('account', '/account/usage');
  const meters = await get<Meter[]>('/usage');
  return (
    <ZoneFrame zone="account" path="/account/usage" zones={ZONES}>
      <PageHeader title="Usage" subtitle="This calendar month, counted as it happens." />
      {meters.length ? meters.map((m) => (
        <Card key={m.key} title={m.name}>
          <p style={{ marginTop: 0 }}><strong>{m.used.toLocaleString('en-IN')}</strong> {m.limit != null ? <>of {m.limit.toLocaleString('en-IN')} included</> : '(unlimited)'} in {m.month}
            {m.percent != null ? <> {m.percent >= 100 ? <Badge tone="danger">{m.percent}%</Badge> : m.percent >= 80 ? <Badge tone="warning">{m.percent}%</Badge> : <Badge tone="success">{m.percent}%</Badge>}</> : null}</p>
          {m.limit != null ? (
            <div role="meter" aria-label={`${m.name} used`} aria-valuenow={m.used} aria-valuemin={0} aria-valuemax={m.limit} style={{ height: 10, borderRadius: 5, background: 'var(--line, #e5e7eb)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, m.percent ?? 0)}%`, height: '100%', background: (m.percent ?? 0) >= 100 ? 'var(--danger, #dc2626)' : (m.percent ?? 0) >= 80 ? '#d97706' : 'var(--brand, #0f766e)' }} />
            </div>
          ) : null}
          {m.overage ? <p className="mc-meta">Beyond the allowance: {RULE[m.overage]}.</p> : null}
          {m.history.length ? <Table rows={m.history} empty="" columns={[
            { header: 'Month', cell: (h) => h.month },
            { header: 'Used', cell: (h) => h.used.toLocaleString('en-IN') },
            { header: '', cell: (h) => (h.billed ? <Badge>invoiced</Badge> : null) },
          ]} /> : null}
        </Card>
      )) : <Card><p style={{ margin: 0 }}>Nothing metered on this plan.</p></Card>}
    </ZoneFrame>
  );
}
