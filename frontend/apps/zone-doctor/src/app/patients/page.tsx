import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, Field, PageHeader } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Lookup { patient: { id: string; name: string; mrn: string; age: number | null; gender: string | null }; access: 'TREATING' | 'BREAK_GLASS' | 'NONE' }

/** Open a patient's record by MRN (exact match only; every lookup is audited). */
export default async function Patients({ searchParams }: { searchParams: Promise<{ mrn?: string; ok?: string; error?: string }> }) {
  await zoneCapabilities('doctor', '/doctor/patients');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  let found: Lookup | null = null;
  let error: string | undefined;
  if (sp.mrn) {
    try {
      found = await api<Lookup>(`/api/records/v1/patients/lookup?mrn=${encodeURIComponent(sp.mrn)}`, { token });
    } catch (e) {
      if (!(e instanceof ApiError) || ![400, 404].includes(e.status)) throw e;
      error = e.status === 404 ? `No patient with MRN ${sp.mrn.toUpperCase()}` : e.problem.errors?.[0]?.message ?? e.message;
    }
  }
  return (
    <ZoneFrame zone="doctor" path="/doctor/patients" zones={ZONES}>
      <PageHeader title="Patients" subtitle="Open a record by MRN. You can read the records of patients you are treating; lookups are recorded." />
      <Flash ok={sp.ok} error={sp.error ?? error} />
      <Card>
        <form method="get" className="mc-form">
          <Field label="MRN" name="mrn" defaultValue={sp.mrn ?? ''} required placeholder="MRN100023" />
          <Button>Find</Button>
        </form>
      </Card>
      {found ? (
        <Card title={`${found.patient.name} · ${found.patient.mrn}`}>
          <p className="mc-meta" style={{ marginTop: 0 }}>{found.patient.age ?? '?'} y{found.patient.gender ? ` · ${found.patient.gender.toLowerCase()}` : ''}</p>
          {found.access === 'NONE'
            ? <Alert tone="info">You have no appointment or visit with this patient. In an emergency you can open the record with break-glass.</Alert>
            : <p><Badge tone={found.access === 'TREATING' ? 'success' : 'warning'}>{found.access === 'TREATING' ? 'your patient' : 'emergency access active'}</Badge></p>}
          <a className="mc-btn mc-btn-primary" href={`/doctor/patients/${found.patient.id}`}>Open record</a>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
