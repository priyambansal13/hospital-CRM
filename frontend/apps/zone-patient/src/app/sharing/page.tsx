import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Button, Card, CheckboxGroup, Chip, PageHeader, Select, Table } from '@mc/ui';
import { myPatients } from '@/lib/booking';
import { Flash } from '@/lib/flash';
import { revokeShare, shareRecord } from '@/lib/health-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Consent { id: string; doctor: { id: string; name: string }; scope: string[]; validUntil: string; revokedAt: string | null; active: boolean }
const SCOPES = [{ value: 'DOCUMENTS', label: 'Reports and documents' }, { value: 'PRESCRIPTIONS', label: 'Prescriptions' }, { value: 'NOTES', label: "Doctors' visit notes" }];
const day = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Let a doctor who is not treating you (yet) see parts of your record, for a while; stop it any time. */
export default async function Sharing({ searchParams }: { searchParams: Promise<{ patientId?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('patient', '/care/sharing');
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path="/care/sharing" zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const family = await myPatients(token);
  const p = family.find((x) => x.id === sp.patientId) ?? family.find((x) => x.isSelf) ?? family[0];
  if (!p) return <ZoneFrame zone="patient" path="/care/sharing" zones={ZONES}><Card><p>Complete <a href="/care/profile">your profile</a> first.</p></Card></ZoneFrame>;
  const [consents, doctors] = await Promise.all([
    api<Consent[]>(`/api/patient/v1/me/consents?patientId=${p.id}`, { token }),
    api<{ items: { id: string; name: string; specialties: { name: string }[] }[] }>('/api/provider/v1/public/doctors?limit=50'),
  ]);
  return (
    <ZoneFrame zone="patient" path="/care/sharing" zones={ZONES}>
      <PageHeader title="Share my record" subtitle="Doctors treating you can already see your record. Use this to let another doctor here see it, for a limited time." />
      {family.length > 1 ? <div className="mc-chips">{family.map((x) => <Chip key={x.id} href={`/care/sharing?patientId=${x.id}`} active={x.id === p.id}>{x.fullName}</Chip>)}</div> : null}
      <Flash ok={sp.ok} error={sp.error} />
      <Card title={`Share ${p.fullName}'s record`}>
        <form action={shareRecord} className="mc-form">
          <input type="hidden" name="patientId" value={p.id} />
          <Select label="Doctor" name="doctorId" required options={doctors.items.map((d) => ({ value: d.id, label: `${d.name}${d.specialties?.[0] ? ` (${d.specialties[0].name})` : ''}` }))} />
          <Select label="For" name="days" defaultValue="30" options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '1 year' }]} />
          <CheckboxGroup legend="What they can see" name="scope" options={SCOPES} defaultValues={['DOCUMENTS', 'PRESCRIPTIONS']} />
          <Button>Share</Button>
        </form>
      </Card>
      <Card title="Shared with">
        <Table
          rows={consents}
          empty="Not shared with anyone."
          columns={[
            { header: 'Doctor', cell: (c) => c.doctor.name },
            { header: 'Can see', cell: (c) => c.scope.map((s) => SCOPES.find((x) => x.value === s)?.label ?? s).join(', ') },
            { header: 'Until', cell: (c) => day(c.validUntil) },
            { header: '', cell: (c) => (c.active
              ? <form action={revokeShare} className="mc-inline"><input type="hidden" name="patientId" value={p.id} /><input type="hidden" name="consentId" value={c.id} /><Button variant="ghost">Stop sharing</Button></form>
              : <Badge>{c.revokedAt ? 'stopped' : 'expired'}</Badge>) },
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
