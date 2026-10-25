import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Card, Chip, PageHeader, Table } from '@mc/ui';
import { myPatients } from '@/lib/booking';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Entry { id: string; occurredAt: string; who: string; action: string; what: string; purpose: string }

const WHAT: Record<string, string> = {
  CHART: 'your record', ENCOUNTER: 'visit notes', PRESCRIPTION: 'a prescription', PATIENT: 'your details', GRANT: 'your record', PRESCRIPTION_LIST: 'your prescriptions',
  DOCUMENT: 'a document', DOCUMENT_LIST: 'your documents', TIMELINE: 'your health timeline', ALLERGIES: 'your allergies', ALLERGY: 'an allergy',
};
const DID: Record<string, string> = { READ: 'viewed', CREATE: 'wrote', UPDATE: 'updated', SIGN: 'signed', AMEND: 'amended', EXPORT: 'downloaded', BREAK_GLASS: 'opened (emergency access)', LOOKUP: 'looked up' };
const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Who opened the record of you or a family member (staff only; your own views are not listed). */
export default async function AccessLog({ searchParams }: { searchParams: Promise<{ patientId?: string }> }) {
  const caps = await zoneCapabilities('patient', '/care/access-log');
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path="/care/access-log" zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  const family = await myPatients(token);
  const sp = await searchParams;
  const current = family.find((p) => p.id === sp.patientId) ?? family.find((p) => p.isSelf) ?? family[0];
  const log = current ? await api<Entry[]>(`/api/audit/v1/me/access-log?patientId=${current.id}`, { token }) : [];
  const emergencies = log.filter((e) => e.purpose === 'BREAK_GLASS' && e.action === 'BREAK_GLASS');
  return (
    <ZoneFrame zone="patient" path="/care/access-log" zones={ZONES}>
      <PageHeader title="Who opened my record" subtitle="Every time hospital staff look at or change a medical record, it is recorded here." />
      {family.length > 1 ? <div className="mc-chips">{family.map((p) => <Chip key={p.id} href={`/care/access-log?patientId=${p.id}`} active={p.id === current?.id}>{p.fullName}</Chip>)}</div> : null}
      {emergencies.length ? <Alert tone="error">{emergencies.map((e) => `${e.who} used emergency access on ${when(e.occurredAt)}`).join('. ')}. The hospital reviews every emergency access.</Alert> : null}
      <Card>
        <Table
          rows={log}
          empty="Nobody has opened this record yet."
          columns={[
            { header: 'When', cell: (e) => when(e.occurredAt) },
            { header: 'Who', cell: (e) => e.who },
            { header: 'What', cell: (e) => `${DID[e.action] ?? e.action.toLowerCase()} ${WHAT[e.what] ?? e.what.toLowerCase()}` },
            { header: 'Why', cell: (e) => <Badge tone={e.purpose === 'BREAK_GLASS' ? 'danger' : 'neutral'}>{e.purpose === 'TREATMENT' ? 'treating doctor' : e.purpose === 'BREAK_GLASS' ? 'emergency' : e.purpose === 'CONSENT' ? 'you shared it' : 'record lookup'}</Badge> },
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
