import { getSession } from '@mc/auth';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Button, Card, Field, PageHeader, Select, Table } from '@mc/ui';
import { fmtDay, myPatients, RELATIONS } from '@/lib/booking';
import { updateDependent } from '@/lib/family-actions';
import { addDependent, saveNotificationPrefs, saveProfile } from '@/lib/booking-actions';
import { api } from '@mc/bff';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const GENDERS = [{ value: '', label: 'Prefer not to say' }, { value: 'FEMALE', label: 'Female' }, { value: 'MALE', label: 'Male' }, { value: 'OTHER', label: 'Other' }];

export default async function Profile({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('patient', '/care/profile');
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path="/care/profile" zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  const [patients, prefs] = await Promise.all([
    myPatients(token),
    api<{ phone: string | null; email: string | null; smsEnabled: boolean; emailEnabled: boolean; language: string }>('/api/notification/v1/me/notification-preferences', { token }),
  ]);
  const self = patients.find((p) => p.isSelf);
  return (
    <ZoneFrame zone="patient" path="/care/profile" zones={ZONES}>
      <PageHeader title="My family" subtitle="You can book appointments for yourself and the family members you add here." />
      <Flash {...await searchParams} />
      <Card title="Your details">
        <form action={saveProfile} className="mc-form">
          <input type="hidden" name="back" value="/care/profile" />
          <Field label="Full name" name="fullName" required defaultValue={self?.fullName} autoComplete="name" />
          <Field label="Date of birth" name="dob" type="date" required defaultValue={self?.dob} />
          <Select label="Gender" name="gender" defaultValue={self?.gender ?? ''} options={GENDERS} />
          <Field label="Email (optional)" name="email" type="email" autoComplete="email" defaultValue={self?.email ?? undefined} />
          <Button>{self ? 'Save' : 'Create my record'}</Button>
        </form>
        {self ? <p className="mc-meta" style={{ marginBottom: 0 }}>Hospital record number: {self.mrn}</p> : null}
      </Card>
      {self ? (
        <Card title="Messages">
          <form action={saveNotificationPrefs} className="mc-form">
            <label className="mc-check"><input type="checkbox" name="sms" defaultChecked={prefs.smsEnabled} /> <span>SMS{prefs.phone ? ` to ${prefs.phone}` : ' to your mobile number'}</span></label>
            <label className="mc-check"><input type="checkbox" name="email" defaultChecked={prefs.emailEnabled} /> <span>Email{self?.email ? ` to ${self.email}` : ' (add an email above)'}</span></label>
            <Select label="Language" name="language" defaultValue={prefs.language} options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिन्दी (Hindi)' }]} />
            <Button variant="ghost">Save preferences</Button>
          </form>
          <p className="mc-meta" style={{ marginBottom: 0 }}>We send booking confirmations and reminders 24 hours and 2 hours before each appointment.</p>
        </Card>
      ) : null}
      {self ? (
        <Card title="Family members">
          <Table
            rows={patients.filter((p) => !p.isSelf)}
            empty="No family members yet."
            columns={[
              { header: 'Name', cell: (p) => p.fullName },
              { header: 'Relation', cell: (p) => p.relation.charAt(0) + p.relation.slice(1).toLowerCase() },
              { header: 'Date of birth', cell: (p) => fmtDay(p.dob, { day: 'numeric', month: 'short', year: 'numeric' }) },
              { header: 'Record no.', cell: (p) => p.mrn },
              // E-6: correct a family member's details
              { header: '', cell: (p) => (
                <details>
                  <summary>Edit</summary>
                  <form action={updateDependent} className="mc-form" aria-label={`Edit ${p.fullName}`}>
                    <input type="hidden" name="id" value={p.id} /><input type="hidden" name="version" value={p.version} />
                    <Field label="Full name" name="fullName" required defaultValue={p.fullName} />
                    <Field label="Date of birth" name="dob" type="date" required defaultValue={p.dob} />
                    <Select label="Relation" name="relation" options={RELATIONS} defaultValue={p.relation} />
                    <Button>Save</Button>
                  </form>
                </details>
              ) },
            ]}
          />
          <form action={addDependent} className="mc-form" style={{ marginTop: 16 }}>
            <input type="hidden" name="back" value="/care/profile" />
            <Field label="Full name" name="fullName" required />
            <Field label="Date of birth" name="dob" type="date" required />
            <Select label="Relation" name="relation" options={RELATIONS} />
            <Select label="Gender" name="gender" options={GENDERS} />
            <Button variant="ghost">Add family member</Button>
          </form>
        </Card>
      ) : null}
      {self ? (
        <Card title="Your data">
          <p style={{ marginTop: 0 }}>Download a copy of everything this hospital holds for you and your family: profile, visits, prescriptions, lab tests, bills, and who looked at your records.</p>
          <a className="mc-btn mc-btn-ghost" href="/care/export" download>Download my data</a>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
