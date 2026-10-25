import { getSession } from '@mc/auth';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { listSpecialties, type Specialty } from '@/lib/directory';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { addSpecialty, toggleSpecialty } from './actions';

export const dynamic = 'force-dynamic';

export default async function Specialties({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await zoneCapabilities('admin', '/admin/specialties');
  const { accessToken: token } = (await getSession())!;
  const specialties = await listSpecialties(token);
  return (
    <ZoneFrame zone="admin" path="/admin/specialties" zones={ZONES}>
      <PageHeader title="Specialties" subtitle="What patients choose from when they look for a doctor." />
      <Flash {...await searchParams} />
      <Card title="Add a specialty">
        <form action={addSpecialty} className="mc-form">
          <Field label="Name" name="name" required placeholder="Rheumatology" />
          <Field label="Short description" name="description" placeholder="Arthritis and joint inflammation" />
          <Button>Add</Button>
        </form>
      </Card>
      <Card title={`Specialties (${specialties.length})`}>
        <Table
          rows={specialties}
          empty="No specialties."
          columns={[
            { header: 'Name', cell: (s: Specialty) => s.name },
            { header: 'Description', cell: (s) => <span className="mc-meta">{s.description ?? '—'}</span> },
            { header: 'Doctors', cell: (s) => s.doctorCount },
            { header: 'Shown to patients', cell: (s) => <Badge tone={s.active ? 'success' : 'neutral'}>{s.active ? 'Yes' : 'Hidden'}</Badge> },
            {
              header: 'Action',
              cell: (s) => (
                <form action={toggleSpecialty}>
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="active" value={String(!s.active)} />
                  <Button variant="ghost">{s.active ? 'Hide' : 'Show'}</Button>
                </form>
              ),
            },
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
