import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Card, PageHeader, Table } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Row { id: string; name: string; status: string; hours: number; openNext7Days: number }

export default async function Schedules() {
  await zoneCapabilities('admin', '/admin/schedules');
  const { accessToken: token } = (await getSession())!;
  const doctors = await api<Row[]>('/api/scheduling/v1/doctors', { token });
  return (
    <ZoneFrame zone="admin" path="/admin/schedules" zones={ZONES}>
      <PageHeader title="Schedules" subtitle="Working hours and leave for every doctor." />
      <Card>
        <Table
          rows={doctors}
          empty="No doctors yet. Add them under Doctors."
          columns={[
            { header: 'Doctor', cell: (d) => <a href={`/admin/schedules/${d.id}`}>{d.name}</a> },
            { header: 'Weekly hours', cell: (d) => (d.hours ? `${d.hours} blocks` : <Badge tone="warning">Not set</Badge>) },
            { header: 'Open slots (next 7 days)', cell: (d) => d.openNext7Days },
            { header: 'Profile', cell: (d) => <Badge tone={d.status === 'ACTIVE' ? 'success' : 'neutral'}>{d.status === 'ACTIVE' ? 'Published' : d.status === 'DRAFT' ? 'Draft' : 'Unpublished'}</Badge> },
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
