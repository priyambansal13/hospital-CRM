import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Button, Card, Chip, PageHeader, TextArea } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { book } from '@/lib/actions';
import { age, type Board, branches, type Patient } from '@/lib/desk';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Slot { slotId: string; localTime: string; now: boolean }

/** Book a visit for a patient at the desk: pick the doctor, then a time today or "join the queue now". */
export default async function DeskBook({ searchParams }: { searchParams: Promise<{ patientId?: string; branch?: string; doctor?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('desk', '/desk/book');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const patient = sp.patientId ? await api<Patient>(`/api/patient/v1/desk/patients/${encodeURIComponent(sp.patientId)}`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))) : null;
  if (!patient) notFound();
  const { all, current } = await branches(token, sp.branch, caps, 'walkin:create:branch');
  const board = current ? await api<Board>(`/api/scheduling/v1/desk/board?branchId=${current.id}`, { token }) : null;
  const doctors = board?.doctors ?? [];
  const doctor = doctors.find((d) => d.id === sp.doctor) ?? (doctors.length === 1 ? doctors[0] : undefined);
  const slots = doctor && current ? await api<Slot[]>(`/api/scheduling/v1/desk/doctors/${doctor.id}/slots?branchId=${current.id}`, { token }) : [];
  const link = (q: Record<string, string>) => `/desk/book?${new URLSearchParams({ patientId: patient.id, ...(current ? { branch: current.id } : {}), ...q })}`;

  return (
    <ZoneFrame zone="desk" path="/desk/book" zones={ZONES}>
      <PageHeader title={`Book a visit for ${patient.fullName}`} subtitle={`${patient.mrn} · ${age(patient.dob)} years · ${patient.phone ?? 'no mobile'}`} />
      <Flash ok={sp.ok} error={sp.error} />
      {all.length > 1 ? <div className="mc-chips">{all.map((b) => <Chip key={b.id} href={`/desk/book?patientId=${patient.id}&branch=${b.id}`} active={b.id === current?.id}>{b.name}</Chip>)}</div> : null}
      <Card title="Doctor">
        {doctors.length ? (
          <div className="mc-chips">
            {doctors.map((d) => (
              <Chip key={d.id} href={link({ doctor: d.id })} active={d.id === doctor?.id}>
                {d.name} · {d.appointments.filter((a) => a.status === 'CHECKED_IN').length} waiting
              </Chip>
            ))}
          </div>
        ) : <p className="mc-muted">No doctors work at this branch.</p>}
      </Card>
      {doctor && current ? (
        <Card title={`When? (${doctor.name}, today)`}>
          <form action={book} className="mc-form">
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <input type="hidden" name="patientId" value={patient.id} />
            <input type="hidden" name="doctorId" value={doctor.id} />
            <input type="hidden" name="branchId" value={current.id} />
            <fieldset className="mc-fieldset mc-field-wide">
              <legend>Time</legend>
              <div className="mc-radios">
                <label className="mc-radio">
                  <input type="radio" name="pick" value="walkin" defaultChecked={!slots.some((s) => s.now)} required />
                  <span>Join the queue now <span className="mc-meta">(walk-in, no booked time)</span></span>
                </label>
                {slots.map((s, i) => (
                  <label key={s.slotId} className="mc-radio">
                    <input type="radio" name="pick" value={s.slotId} defaultChecked={s.now && i === 0} />
                    <span>{s.localTime}{s.now ? <span className="mc-meta"> (now)</span> : null}</span>
                  </label>
                ))}
              </div>
              {!slots.length ? <small className="mc-muted">No free times left today: the patient can still join the queue.</small> : null}
            </fieldset>
            <TextArea label="Reason for visit (optional)" name="reason" rows={2} maxLength={500} />
            <label className="mc-check mc-field-wide"><input type="checkbox" name="checkIn" defaultChecked /> <span>Check in now (patient is here)</span></label>
            <Button>Book</Button>
          </form>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
