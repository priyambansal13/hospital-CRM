import { getSession } from '@mc/auth';
import { ApiError, origin } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Button, Card, Field, PageHeader, Select, TextArea } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { fmtDay, fmtTime, myPatients, RELATIONS, slotDetail } from '@/lib/booking';
import { addDependent, bookAppointment, saveProfile } from '@/lib/booking-actions';
import { canPayOnline, inr } from '@/lib/billing';
import { onlinePaymentsReady } from '@/lib/payments';
import { Flash } from '@/lib/flash';
import { BookingPaused } from '@/lib/booking-paused';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

export default async function ConfirmBooking({ params, searchParams }: { params: Promise<{ slotId: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { slotId } = await params;
  const path = `/care/book/${slotId}`;
  const caps = await zoneCapabilities('patient', path);
  if (!caps.permissions.includes('appointment:create:own')) {
    return <ZoneFrame zone="patient" path="/care/doctors" zones={ZONES}><PageHeader title="Book an appointment" /><BookingPaused /></ZoneFrame>;
  }
  const slot = await slotDetail(slotId).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  if (caps.actor.kind !== 'patient') {
    return (
      <ZoneFrame zone="patient" path={path} zones={ZONES}>
        <Alert tone="error">Online booking is for patients. Staff book appointments from the front desk.</Alert>
      </ZoneFrame>
    );
  }
  if (!slot.available) redirect(`${await origin()}/care/doctors/${slot.doctor.id}?error=${encodeURIComponent('That time is no longer available. Please pick another.')}`);
  const { accessToken: token } = (await getSession())!;
  const patients = await myPatients(token);
  const self = patients.find((p) => p.isSelf);
  const sp = await searchParams;
  const online = canPayOnline(caps) && caps.permissions.includes('payment:create:own') && !!slot.fee && slot.fee > 0 && (await onlinePaymentsReady());
  return (
    <ZoneFrame zone="patient" path={path} zones={ZONES}>
      <PageHeader title="Confirm your appointment" />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="mc-split">
      <div className="mc-split-main">
      {!self ? (
        <Card title="First, tell us about you">
          <p className="mc-muted" style={{ marginTop: 0 }}>We need a few details once to create your hospital record.</p>
          <form action={saveProfile} className="mc-form">
            <input type="hidden" name="back" value={path} />
            <Field label="Full name" name="fullName" required autoComplete="name" />
            <Field label="Date of birth" name="dob" type="date" required />
            <Select label="Gender" name="gender" options={[{ value: '', label: 'Prefer not to say' }, { value: 'FEMALE', label: 'Female' }, { value: 'MALE', label: 'Male' }, { value: 'OTHER', label: 'Other' }]} />
            <Field label="Email (optional)" name="email" type="email" autoComplete="email" />
            <Button>Save and continue</Button>
          </form>
        </Card>
      ) : (
        <>
          <Card title="Who is the appointment for?">
            <form action={bookAppointment} className="mc-form" style={{ gridTemplateColumns: '1fr' }}>
              <input type="hidden" name="slotId" value={slot.slotId} />
              <input type="hidden" name="doctorId" value={slot.doctor.id} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <fieldset className="mc-fieldset">
                <legend>Patient</legend>
                <div className="mc-radios">
                  {patients.map((p, i) => (
                    <label key={p.id} className="mc-radio">
                      <input type="radio" name="patientId" value={p.id} defaultChecked={i === 0} required />
                      <span>{p.fullName} <span className="mc-meta">({p.isSelf ? 'you' : p.relation.toLowerCase()} · {p.mrn})</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <TextArea label="Reason for visit (optional)" name="reason" maxLength={500} placeholder="e.g. chest pain when climbing stairs" />
              {online ? (
                <fieldset className="mc-fieldset">
                  <legend>Payment</legend>
                  <div className="mc-radios">
                    <label className="mc-radio">
                      <input type="radio" name="paymentMode" value="ONLINE" defaultChecked />
                      <span>Pay {inr(slot.fee!)} now <span className="mc-meta">(UPI, card or net banking; confirmed instantly)</span></span>
                    </label>
                    <label className="mc-radio">
                      <input type="radio" name="paymentMode" value="AT_CLINIC" />
                      <span>Pay at the hospital</span>
                    </label>
                  </div>
                </fieldset>
              ) : <input type="hidden" name="paymentMode" value="AT_CLINIC" />}
              <Button>{online ? 'Continue' : 'Confirm booking'}</Button>
            </form>
          </Card>
          <Card title="Booking for a family member?">
            <form action={addDependent} className="mc-form">
              <input type="hidden" name="back" value={path} />
              <Field label="Full name" name="fullName" required />
              <Field label="Date of birth" name="dob" type="date" required />
              <Select label="Relation" name="relation" options={RELATIONS} />
              <Select label="Gender" name="gender" options={[{ value: '', label: 'Prefer not to say' }, { value: 'FEMALE', label: 'Female' }, { value: 'MALE', label: 'Male' }, { value: 'OTHER', label: 'Other' }]} />
              <Button variant="ghost">Add family member</Button>
            </form>
          </Card>
        </>
      )}
      </div>
      <aside className="mc-split-side mc-split-form" aria-label="Your appointment">
        <Card title="Appointment">
          <div className="mc-doccard-top" style={{ marginBottom: 14 }}>
            <span className="mc-avatar" aria-hidden>{slot.doctor.name.replace(/^Dr\.?\s*/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
            <div><strong>{fmtDay(slot.localDate, { weekday: 'long', day: 'numeric', month: 'long' })}</strong><div className="mc-kpi-value" style={{ fontSize: '1.6rem' }}>{fmtTime(slot.localTime)}</div></div>
          </div>
          <dl className="mc-summary">
            <dt>Doctor</dt><dd>{slot.doctor.name}</dd>
            <dt>When</dt><dd>{fmtDay(slot.localDate, { weekday: 'long', day: 'numeric', month: 'long' })}, {fmtTime(slot.localTime)}</dd>
            <dt>Where</dt><dd>{slot.mode === 'VIDEO' ? 'Video consultation' : slot.branch.name}</dd>
            <dt>Fee</dt><dd>{slot.fee != null ? `${inr(slot.fee)}${online ? '' : ', pay at the hospital'}` : 'Pay at the hospital'}</dd>
          </dl>
        </Card>
      </aside>
      </div>
    </ZoneFrame>
  );
}
