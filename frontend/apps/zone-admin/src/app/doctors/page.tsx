import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { type Doctor, listBranches, listSpecialties } from '@/lib/directory';
import { DoctorFields, statusBadge } from '@/lib/doctor-form';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { createDoctor, setDoctorStatus } from './actions';

export const dynamic = 'force-dynamic';

export default async function Doctors({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; q?: string }> }) {
  await zoneCapabilities('admin', '/admin/doctors');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const [doctors, specialties, branches] = await Promise.all([
    api<{ items: Doctor[] }>(`/api/provider/v1/doctors?limit=100${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ''}`, { token }),
    listSpecialties(token),
    listBranches(token),
  ]);
  return (
    <ZoneFrame zone="admin" path="/admin/doctors" zones={ZONES}>
      <PageHeader title="Doctors" subtitle="Add doctors, set their branches and fees, and publish their profiles for patients." />
      <Flash ok={sp.ok} error={sp.error} />
      {/* the list is the page; adding sits beside it */}
      <div className="mc-split">
        <div className="mc-split-main">
        <Card title={`All doctors (${doctors.items.length})`}>
          <form method="get" className="mc-form" style={{ marginBottom: 12 }}>
            <Field label="Search by name or specialty" name="q" defaultValue={sp.q} />
            <Button variant="ghost">Search</Button>
          </form>
          <Table
            rows={doctors.items}
            empty="No doctors yet."
            columns={[
              { header: 'Name', cell: (d) => <a href={`/admin/doctors/${d.id}`}>{d.name}</a> },
              { header: 'Specialties', cell: (d) => d.specialties.map((s) => s.name).join(', ') },
              { header: 'Branches', cell: (d) => <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{d.branches.map((b) => <Badge key={b.id ?? b.name}>{b.name ?? '?'} · ₹{b.fee}</Badge>)}</span> },
              { header: 'Status', cell: (d) => statusBadge(d.status) },
              {
                header: 'Action',
                cell: (d) => (
                  <form action={setDoctorStatus}>
                    <input type="hidden" name="id" value={d.id} />
                    <input type="hidden" name="status" value={d.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'} />
                    <Button variant="ghost">{d.status === 'ACTIVE' ? 'Unpublish' : 'Publish'}</Button>
                  </form>
                ),
              },
            ]}
          />
        </Card>
        </div>
        <aside className="mc-split-side" aria-label="Add a doctor">
        <Card title="Add a doctor">
          <form action={createDoctor} className="mc-form">
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <Field label="Email (for sign-in)" name="email" type="email" required autoComplete="off" />
            <Field label="Medical registration no." name="registrationNo" required placeholder="DMC/12345" />
            <DoctorFields specialties={specialties} branches={branches} />
            <Button>Add doctor</Button>
          </form>
        </Card>
        </aside>
      </div>
    </ZoneFrame>
  );
}
