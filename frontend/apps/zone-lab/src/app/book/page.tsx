import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { branchesFor, can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Button, Card, Chip, Field, PageHeader, Table } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { bookTests, scheduleOrder } from '@/lib/book-actions';
import { Flash } from '@/lib/flash';
import { type LabOrder } from '@/lib/lab';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Patient { id: string; mrn: string; fullName: string; dob: string; phone: string | null }
interface Test { id: string; code: string; name: string; price: number; preparation: string | null; sampleType: string }
interface Slots { slots: { slotAt: string; localTime: string; left: number }[] }

const days = (n: number) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.now() + i * 86_400_000);
  return { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d), label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(d) };
});

/**
 * Book lab tests for a patient at the counter or on the phone (D-3): find the patient, give a time to tests their doctor
 * ordered, or pick tests. Pay at the lab; a patient who is here can take the slot running now.
 */
export default async function BookTests({ searchParams }: { searchParams: Promise<{ q?: string; patientId?: string; branch?: string; date?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('lab', '/lab/book');
  if (!can(caps, 'lab_order:create:branch')) notFound();
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const canSearch = can(caps, 'patient:register:branch');
  const q = sp.q?.trim() ?? '';
  const found = canSearch && q.length >= 3 ? await api<Patient[]>(`/api/patient/v1/desk/patients?q=${encodeURIComponent(q)}`, { token }).catch(() => [] as Patient[]) : [];
  const patient = sp.patientId ? await api<Patient>(`/api/patient/v1/desk/patients/${encodeURIComponent(sp.patientId)}`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))) : null;
  const branches = branchesFor(caps, 'lab_order:create:branch', await api<{ id: string; name: string }[]>('/api/diagnostics/v1/public/lab-branches', { token }));
  const branch = branches.find((b) => b.id === sp.branch) ?? branches[0];
  const dayList = days(14);
  const date = dayList.find((d) => d.date === sp.date)?.date ?? dayList[0].date;
  const [catalog, slots, waiting] = patient && branch ? await Promise.all([
    api<{ tests: Test[] }>('/api/diagnostics/v1/public/lab-catalog', { token }),
    api<Slots>(`/api/diagnostics/v1/desk/lab-slots?branchId=${branch.id}&date=${date}`, { token }).catch(() => ({ slots: [] } as Slots)),
    api<LabOrder[]>(`/api/diagnostics/v1/desk/patients/${patient.id}/lab-orders/waiting`, { token }).catch(() => [] as LabOrder[]),
  ]) : [null, null, [] as LabOrder[]];
  const here = `/lab/book?${new URLSearchParams({ ...(patient ? { patientId: patient.id } : {}), ...(branch ? { branch: branch.id } : {}), date })}`;
  const open = (slots?.slots ?? []).filter((s) => s.left > 0);
  const TimePick = () => (
    <fieldset className="mc-fieldset mc-field-wide">
      <legend>Time</legend>
      {open.length ? <div className="mc-radios">{open.map((s, i) => <label key={s.slotAt} className="mc-radio"><input type="radio" name="slotAt" value={s.slotAt} defaultChecked={i === 0} required /> <span>{s.localTime} <span className="mc-meta">({s.left} left)</span></span></label>)}</div>
        : <small className="mc-muted">No free times on this day: pick another day.</small>}
    </fieldset>
  );

  return (
    <ZoneFrame zone="lab" path="/lab/book" zones={ZONES}>
      <PageHeader title="Book lab tests" subtitle={patient ? `${patient.fullName} · ${patient.mrn}${patient.phone ? ` · ${patient.phone}` : ''}` : 'For a patient at the counter or on the phone'} />
      <Flash ok={sp.ok} error={sp.error} />
      {!patient ? (
        <Card title="Find the patient">
          {canSearch ? (
            <>
              <form method="get" className="mc-form"><Field label="Mobile, MRN or name" name="q" defaultValue={q} required /><Button>Search</Button></form>
              {q ? <Table rows={found} empty="Nobody found. New patients are registered at the front desk." columns={[
                { header: 'Patient', cell: (p) => <>{p.fullName} <span className="mc-meta">{p.mrn}</span></> },
                { header: 'Mobile', cell: (p) => p.phone ?? '—' },
                { header: '', cell: (p) => <a className="mc-btn mc-btn-primary" href={`/lab/book?patientId=${p.id}`}>Book tests</a> },
              ]} /> : null}
            </>
          ) : <Alert>Ask the front desk to find or register the patient, then book their tests from there.</Alert>}
        </Card>
      ) : !branch ? <Alert>No lab branch you work at.</Alert> : (
        <>
          {branches.length > 1 ? <div className="mc-chips">{branches.map((b) => <Chip key={b.id} href={`/lab/book?${new URLSearchParams({ patientId: patient.id, branch: b.id, date })}`} active={b.id === branch.id}>{b.name}</Chip>)}</div> : null}
          <div className="mc-chips" aria-label="Day">{dayList.map((d) => <Chip key={d.date} href={`/lab/book?${new URLSearchParams({ patientId: patient.id, branch: branch.id, date: d.date })}`} active={d.date === date}>{d.label}</Chip>)}</div>
          {waiting.map((o) => (
            <Card key={o.id} title={`${o.status === 'SAMPLE_REJECTED' ? 'Sample to repeat' : 'Ordered by the doctor'}: ${o.orderNo}`}>
              <p className="mc-meta">{o.tests.map((t) => t.name).join(', ')}{o.orderedBy?.name ? ` · ${o.orderedBy.name}` : ''}</p>
              <form action={scheduleOrder} className="mc-form">
                <input type="hidden" name="orderId" value={o.id} />
                <input type="hidden" name="branchId" value={branch.id} />
                <input type="hidden" name="back" value={here} />
                <TimePick />
                <Button>Give this time</Button>
              </form>
            </Card>
          ))}
          <Card title="New tests">
            <form action={bookTests} className="mc-form">
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <input type="hidden" name="patientId" value={patient.id} />
              <input type="hidden" name="branchId" value={branch.id} />
              <input type="hidden" name="back" value={here} />
              <fieldset className="mc-fieldset mc-field-wide">
                <legend>Tests</legend>
                <div className="mc-radios">
                  {(catalog?.tests ?? []).map((t) => (
                    <label key={t.id} className="mc-check"><input type="checkbox" name="testId" value={t.id} /> <span>{t.name} <span className="mc-meta">{t.code} · ₹{t.price}{t.preparation ? ` · ${t.preparation}` : ''}</span></span></label>
                  ))}
                </div>
              </fieldset>
              <TimePick />
              <Button>Book (pay at the lab)</Button>
            </form>
          </Card>
        </>
      )}
    </ZoneFrame>
  );
}
