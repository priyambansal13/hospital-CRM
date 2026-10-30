import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Button, Card, Field, PageHeader, Select, Table } from '@mc/ui';
import { registerPatient } from '@/lib/actions';
import { age, type Patient } from '@/lib/desk';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const RELATIONS = [['SELF', 'Phone owner (self)'], ['CHILD', 'Child'], ['SPOUSE', 'Spouse'], ['PARENT', 'Parent'], ['SIBLING', 'Sibling'], ['OTHER', 'Other']] as const;

/** Find a patient by phone, MRN or name; register a walk-in if they are new. */
export default async function DeskPatients({ searchParams }: { searchParams: Promise<{ q?: string; branch?: string; ok?: string; error?: string; highlight?: string }> }) {
  const caps = await zoneCapabilities('desk', '/desk/patients');
  // the lab's booking page (D-3), when the hospital has the lab and the person may book tests
  const labBooking = caps.permissions.includes('lab_order:create:branch') && caps.modules.includes('diagnostics');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const q = sp.q?.trim() ?? '';
  let results: Patient[] | null = null;
  let searchError: string | undefined;
  if (q) {
    try {
      results = await api<Patient[]>(`/api/patient/v1/desk/patients?q=${encodeURIComponent(q)}`, { token });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 400) throw e;
      searchError = e.problem.errors?.[0]?.message ?? e.message;
    }
  }
  const phoneLike = /^[+\d\s-]{10,}$/.test(q);
  const holder = results?.find((p) => p.isSelf);
  // the branch the receptionist is working at travels along to the booking page
  const branch = sp.branch && /^[0-9a-f-]{36}$/.test(sp.branch) ? sp.branch : undefined;

  return (
    <ZoneFrame zone="desk" path="/desk/patients" zones={ZONES}>
      <PageHeader title="Patients" subtitle="Search by mobile number, MRN or name. New patients are registered to a mobile number." />
      <Flash ok={sp.ok} error={sp.error ?? searchError} />
      <Card>
        <form method="get" className="mc-form">
          {branch ? <input type="hidden" name="branch" value={branch} /> : null}
          <Field label="Mobile, MRN or name" name="q" defaultValue={q} required placeholder="98765 43210 · MRN100023 · Priya" />
          <Button>Search</Button>
        </form>
      </Card>
      {results ? (
        <Card title={`${results.length} found`}>
          <Table
            rows={results}
            empty={phoneLike ? 'No patient with this mobile number yet: register them below.' : 'No match. Try the mobile number.'}
            columns={[
              { header: 'Name', cell: (p) => <span data-highlight={p.id === sp.highlight || undefined}>{p.fullName}{p.id === sp.highlight ? ' ←' : ''}</span> },
              { header: 'MRN', cell: (p) => p.mrn },
              { header: 'Age', cell: (p) => `${age(p.dob)} y${p.gender ? ` · ${p.gender[0]}` : ''}` },
              { header: 'Mobile', cell: (p) => p.phone ?? '—' },
              { header: 'Relation', cell: (p) => (p.isSelf ? 'owner' : `${p.relation.toLowerCase()} of ${p.guardianName ?? '—'}`) },
              { header: '', cell: (p) => <span className="mc-inline">
                <a className="mc-btn mc-btn-primary" href={`/desk/book?patientId=${p.id}${branch ? `&branch=${branch}` : ''}`} aria-label={`Book visit for ${p.fullName}`}>Book visit</a>
                {labBooking ? <a className="mc-btn mc-btn-ghost" href={`/lab/book?patientId=${p.id}`} aria-label={`Book lab tests for ${p.fullName}`}>Lab tests</a> : null}
              </span> },
            ]}
          />
        </Card>
      ) : null}
      <Card title={holder ? `Add a family member to ${holder.phone}` : 'Register a new patient'}>
        <form action={registerPatient} className="mc-form">
          {branch ? <input type="hidden" name="branch" value={branch} /> : null}
          <Field label="Mobile number" name="phone" type="tel" inputMode="tel" required defaultValue={phoneLike ? q : holder?.phone ?? ''} hint="Their own, or a parent's for a child" />
          <Field label="Full name" name="fullName" required />
          <Field label="Date of birth" name="dob" type="date" required />
          <Select label="Gender" name="gender" options={[{ value: '', label: '—' }, { value: 'FEMALE', label: 'Female' }, { value: 'MALE', label: 'Male' }, { value: 'OTHER', label: 'Other' }]} />
          <Select label="Who is this?" name="relation" defaultValue={holder ? 'CHILD' : 'SELF'} options={RELATIONS.map(([value, label]) => ({ value, label }))} />
          <Button>Register and book</Button>
        </form>
      </Card>
    </ZoneFrame>
  );
}
