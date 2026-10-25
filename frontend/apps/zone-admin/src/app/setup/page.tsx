import { getSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { addBranch, addDoctor, addHours, connectPayments, finishSetup, saveBranding } from './actions';

export const dynamic = 'force-dynamic';

interface Setup { name: string; source: string; completedAt: string | null; brandingSet: boolean }
interface Branch { id: string; name: string; active: boolean }
interface Doctor { id: string; name: string; status: string }
interface Branding { name: string; branding: { primaryColor?: string; accentColor?: string; logoUrl?: string | null } }
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']] as const;

/** The setup guide after signup: each step is done when the data exists (re-visiting is safe). */
export default async function Setup({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; step?: string }> }) {
  await zoneCapabilities('admin', '/admin/setup');
  const sp = await searchParams;
  const { accessToken: token } = (await getSession())!;
  const [setup, brand, branches, doctors, specialties, account] = await Promise.all([
    api<Setup>('/api/tenant/v1/setup', { token }),
    api<Branding>('/api/tenant/v1/public/branding', { token }),
    api<Branch[]>('/api/tenant/v1/branches', { token }),
    api<{ items: Doctor[] }>('/api/provider/v1/doctors?limit=10', { token }).then((r) => r.items).catch(() => [] as Doctor[]),
    api<{ code: string; name: string; active?: boolean }[]>('/api/provider/v1/specialties', { token }).catch(() => []),
    api<{ connected: boolean }>('/api/billing/v1/payment-account', { token }).catch(() => ({ connected: false })),
  ]);
  const doctor = doctors.find((d) => d.status === 'ACTIVE') ?? doctors[0];
  const hours = doctor ? await api<{ hours: unknown[] }>(`/api/scheduling/v1/doctors/${doctor.id}/schedule`, { token }).then((s) => s.hours?.length ?? 0, () => 0) : 0;
  const steps = [
    { key: 'branding', title: 'Your name and colours', done: setup.brandingSet },
    { key: 'branch', title: 'Your first branch', done: branches.some((b) => b.active) },
    { key: 'doctor', title: 'Your first doctor', done: doctors.some((d) => d.status === 'ACTIVE') },
    { key: 'hours', title: 'Opening hours', done: hours > 0 },
    { key: 'payments', title: 'Online payments', done: account.connected },
  ];
  const done = steps.filter((s) => s.done).length;
  const current = sp.step ?? steps.find((s) => !s.done)?.key ?? 'finish';
  const base = await origin();
  return (
    <ZoneFrame zone="admin" path="/admin/setup" zones={ZONES}>
      <PageHeader title="Set up your hospital" subtitle={setup.completedAt ? 'Setup finished. You can change anything here at any time.' : `${done} of ${steps.length} done. About ten minutes in all.`} />
      <Flash ok={sp.ok} error={sp.error} />
      <ol aria-label="Setup steps" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, listStyle: 'none', padding: 0, margin: '0 0 16px' }}>
        {steps.map((s, i) => <li key={s.key}><a className={`mc-chip${current === s.key ? ' active' : ''}`} href={`/admin/setup?step=${s.key}`}>{i + 1}. {s.title} {s.done ? <Badge tone="success">done</Badge> : null}</a></li>)}
      </ol>

      {current === 'branding' ? (
        <Card title="1. Your name and colours">
          <form action={saveBranding} className="mc-form" aria-label="Branding">
            <Field label="Name patients see" name="name" required defaultValue={brand.name} />
            <label className="mc-field"><span>Main colour</span><input type="color" name="primaryColor" defaultValue={brand.branding.primaryColor ?? '#0f766e'} /></label>
            <label className="mc-field"><span>Accent colour</span><input type="color" name="accentColor" defaultValue={brand.branding.accentColor ?? '#f59e0b'} /></label>
            <Field label="Logo URL (optional)" name="logoUrl" type="url" defaultValue={brand.branding.logoUrl ?? ''} placeholder="https://…/logo.png" />
            <Button>Save and continue</Button>
          </form>
        </Card>
      ) : null}

      {current === 'branch' ? (
        <Card title="2. Your first branch">
          {branches.length ? <p className="mc-meta" style={{ marginTop: 0 }}>You have: {branches.map((b) => b.name).join(', ')}. Add another, or <a href="/admin/setup?step=doctor">continue</a>.</p> : null}
          <form action={addBranch} className="mc-form" aria-label="Branch">
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <Field label="Branch name" name="name" required placeholder="Main clinic" />
            <Field label="City" name="city" required placeholder="Pune" />
            <Field label="Address" name="line1" required placeholder="12 MG Road" />
            <Button>Add branch</Button>
          </form>
        </Card>
      ) : null}

      {current === 'doctor' ? (
        <Card title="3. Your first doctor">
          {!branches.length ? <p>Add a branch first.</p> : (
            <form action={addDoctor} className="mc-form" aria-label="Doctor">
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <Field label="Doctor's name" name="name" required placeholder="Dr. Meera Iyer" />
              <Field label="Doctor's e-mail" name="email" type="email" required hint="They get their own login" />
              <Field label="Registration number" name="registrationNo" required placeholder="MMC/12345" />
              <label className="mc-field"><span>Specialty</span>
                <select name="specialty" required>{specialties.filter((s) => s.active !== false).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select>
              </label>
              <label className="mc-field"><span>Branch</span>
                <select name="branchId" required>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
              </label>
              <Field label="Consultation fee (₹)" name="fee" type="number" defaultValue="500" />
              <Button>Add and publish</Button>
            </form>
          )}
        </Card>
      ) : null}

      {current === 'hours' ? (
        <Card title="4. Opening hours">
          {!doctor ? <p>Add a doctor first.</p> : (
            <form action={addHours} className="mc-form" aria-label="Hours">
              <input type="hidden" name="doctorId" value={doctor.id} />
              <p style={{ margin: 0 }}>When <strong>{doctor.name}</strong> sees patients (more hours and other doctors: Admin → Schedules).</p>
              <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <legend className="mc-meta">Days</legend>
                {DAYS.map(([n, label]) => <label key={n} className="mc-check"><input type="checkbox" name="day" value={n} defaultChecked={n <= 6} aria-label={label} /> <span>{label}</span></label>)}
              </fieldset>
              <label className="mc-field"><span>Branch</span><select name="branchId">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
              <Field label="From" name="startTime" type="time" defaultValue="09:00" required />
              <Field label="To" name="endTime" type="time" defaultValue="13:00" required />
              <label className="mc-field"><span>Each appointment</span><select name="slotMinutes" defaultValue="15">{[10, 15, 20, 30].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></label>
              <Button>Save hours</Button>
            </form>
          )}
        </Card>
      ) : null}

      {current === 'payments' ? (
        <Card title="5. Online payments">
          <p style={{ marginTop: 0 }}>Patients can pay when they book; the money goes to your bank account (MediCare keeps a 1% fee). Without this, patients pay at the hospital.</p>
          {account.connected ? <p><Badge tone="success">connected</Badge> <a href="/admin/settings">Change in Settings</a></p> : (
            <form action={connectPayments} className="mc-form" aria-label="Payments">
              <Field label="Business name (as on PAN)" name="businessName" required defaultValue={brand.name} />
              <label className="mc-field"><span>Business type</span><select name="businessType" defaultValue="proprietorship">
                <option value="proprietorship">Proprietorship</option><option value="partnership">Partnership</option><option value="private_limited">Private limited</option><option value="llp">LLP</option><option value="trust">Trust</option><option value="society">Society</option>
              </select></label>
              <Field label="PAN" name="pan" required placeholder="ABCDE1234F" />
              <Field label="Bank account number" name="accountNumber" required inputMode="numeric" />
              <Field label="IFSC" name="ifsc" required placeholder="HDFC0001234" />
              <Field label="E-mail for payouts" name="email" type="email" required />
              <Button>Connect bank account</Button>
            </form>
          )}
          <p className="mc-meta" style={{ marginBottom: 0 }}><a href="/admin/setup?step=finish">Skip: patients pay at the hospital for now</a></p>
        </Card>
      ) : null}

      {current === 'finish' ? (
        <Card title={setup.completedAt ? 'All set' : 'Almost done'}>
          <p style={{ marginTop: 0 }}>Your patients book at <a href={`${base}/care`}>{base.replace(/^https?:\/\//, '')}/care</a>. Share this link on your website, WhatsApp and Google listing.</p>
          <ul>
            <li><a href="/admin/staff">Invite your staff</a> (front desk, nurses, more doctors)</li>
            <li><a href="/admin/roles">Adjust roles</a> and <a href="/admin/settings">settings</a></li>
            <li><a href="/account">Your subscription</a></li>
          </ul>
          {!setup.completedAt ? <form action={finishSetup}><Button>Finish setup</Button></form> : null}
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
