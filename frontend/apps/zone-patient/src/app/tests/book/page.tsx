import { getSession } from '@mc/auth';
import { api, origin } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Button, Card, Chip, Field, PageHeader } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { canPayOnline } from '@/lib/billing';
import { onlinePaymentsReady } from '@/lib/payments';
import { myPatients } from '@/lib/booking';
import { Flash } from '@/lib/flash';
import { bookLab } from '@/lib/health-actions';
import { homeCheck, homeSlots } from '@/lib/home';
import { bookHomeVisit } from '@/lib/home-actions';
import { catalog, labBranches, type LabOrder, labSlots } from '@/lib/lab';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const label = (d: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

/** Who, where, when and how to pay, for the chosen tests (or for tests a doctor ordered: ?orderId=). */
export default async function BookTests({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const pkgs = list(sp.pkg);
  const tests = list(sp.test);
  const orderId = typeof sp.orderId === 'string' ? sp.orderId : undefined;
  const qs = new URLSearchParams([...pkgs.map((p) => ['pkg', p]), ...tests.map((t) => ['test', t]), ...(orderId ? [['orderId', orderId]] : [])] as [string, string][]);
  const path = `/care/tests/book?${qs}`;
  const caps = await zoneCapabilities('patient', path);
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path={path} zones={ZONES}><Alert tone="error">Booking is for patients.</Alert></ZoneFrame>;
  if (!pkgs.length && !tests.length && !orderId) redirect(`${await origin()}/care/tests?error=${encodeURIComponent('Pick at least one test or package')}`);
  const { accessToken: token } = (await getSession())!;
  const [family, cat, branches] = await Promise.all([myPatients(token), catalog(), labBranches()]);
  if (!family.length) redirect(`${await origin()}/care/profile?ok=${encodeURIComponent('Create your record first, then book tests.')}`);
  const ordered = orderId ? await api<LabOrder>(`/api/diagnostics/v1/lab-orders/${encodeURIComponent(orderId)}`, { token }) : null;
  const chosen = [...cat.packages.filter((p) => pkgs.includes(p.id)).map((p) => ({ name: p.name, price: p.price })), ...cat.tests.filter((t) => tests.includes(t.id)).map((t) => ({ name: t.name, price: t.price }))];
  const items = ordered ? ordered.lines : chosen;
  const total = ordered ? ordered.total : chosen.reduce((s, c) => s + c.price, 0);
  const branch = branches.find((b) => b.id === sp.branch) ?? branches.find((b) => b.name === 'Sector 44') ?? branches[0];
  const date = typeof sp.date === 'string' ? sp.date : plusDays(todayIST(), 1);
  // home collection: offered when the module is on; a home order (e.g. after a missed visit) stays at home
  const homeOffered = caps.modules.includes('home_collection');
  const atHome = homeOffered && (sp.where === 'home' || ordered?.collectionType === 'HOME');
  const pincode = typeof sp.pincode === 'string' && /^[1-9]\d{5}$/.test(sp.pincode) ? sp.pincode : ordered?.homeAddress?.pincode ?? null;
  const area = atHome && pincode ? await homeCheck(pincode) : null;
  const slots = atHome
    ? (area?.serviceable ? (await homeSlots(pincode!, date)).slots.filter((s) => s.left > 0) : [])
    : branch ? (await labSlots(branch.id, date)).slots.filter((s) => s.left > 0) : [];
  const fee = atHome && area?.serviceable && !ordered?.lines.some((l) => l.kind === 'HOME_VISIT') ? area.fee ?? 0 : 0;
  const nav = (x: Record<string, string>) => { const q = new URLSearchParams(qs); if (atHome) { q.set('where', 'home'); if (pincode) q.set('pincode', pincode); } for (const [k, v] of Object.entries(x)) q.set(k, v); return `/care/tests/book?${q}`; };
  const online = canPayOnline(caps) && caps.permissions.includes('payment:create:own') && total + fee > 0 && ordered?.paymentStatus !== 'PAID' && (await onlinePaymentsReady());
  const addr = ordered?.homeAddress;
  return (
    <ZoneFrame zone="patient" path={path} zones={ZONES}>
      <PageHeader title={ordered?.homeVisit?.status === 'MISSED' ? 'Pick a new time for the home visit' : ordered ? `Book the tests ${ordered.orderedBy?.name ?? 'your doctor'} ordered` : 'Book lab tests'} subtitle={`${items.map((i) => i.name).join(' + ')} · ₹${total}${fee ? ` + ₹${fee} home collection` : ''}`} />
      <Flash error={typeof sp.error === 'string' ? sp.error : undefined} />
      {homeOffered && ordered?.collectionType !== 'HOME' ? (
        <nav className="mc-chips" aria-label="Where">
          <Chip href={(() => { const q = new URLSearchParams(qs); return `/care/tests/book?${q}`; })()} active={!atHome}>At the lab</Chip>
          <Chip href={(() => { const q = new URLSearchParams(qs); q.set('where', 'home'); return `/care/tests/book?${q}`; })()} active={atHome}>At home</Chip>
        </nav>
      ) : null}
      {atHome ? (
        <Card title="Where should we come?">
          <form method="get" className="mc-form">
            {[...qs.entries()].map(([k, v], i) => <input key={i} type="hidden" name={k} value={v} />)}
            <input type="hidden" name="where" value="home" />
            <Field label="Pincode" name="pincode" defaultValue={pincode ?? ''} required pattern="[1-9][0-9]{5}" inputMode="numeric" placeholder="e.g. 122003" />
            <Button variant="ghost">Check</Button>
          </form>
          {area ? (area.serviceable
            ? <p className="mc-muted">We collect at home in {area.pincode}{area.area ? ` (${area.area})` : ''}: {area.fee ? `₹${area.fee} visit fee` : 'no visit fee'}. Samples go to our {area.branch?.name} lab.</p>
            : <Alert tone="error">We do not collect samples at home in {area.pincode} yet. Please visit one of our labs.</Alert>) : null}
        </Card>
      ) : null}
      {!atHome && branches.length > 1 ? <div className="mc-chips">{branches.map((b) => <Chip key={b.id} href={nav({ branch: b.id })} active={b.id === branch?.id}>{b.name}</Chip>)}</div> : null}
      {atHome && !area?.serviceable ? null : (<>
      <nav className="mc-chips" aria-label="Days" style={{ marginTop: 8 }}>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => plusDays(todayIST(), n)).map((d) => <Chip key={d} href={nav({ date: d, ...(branch ? { branch: branch.id } : {}) })} active={d === date}>{label(d)}</Chip>)}
      </nav>
      <Card title={`${atHome ? 'At home' : branch?.name ?? 'Lab'} · ${label(date)}`}>
        <form action={atHome ? bookHomeVisit : bookLab} className="mc-form" style={{ gridTemplateColumns: '1fr' }}>
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          {atHome ? <input type="hidden" name="pincode" value={pincode ?? ''} /> : <input type="hidden" name="branchId" value={branch?.id ?? ''} />}
          <input type="hidden" name="back" value={nav({ date, ...(branch ? { branch: branch.id } : {}) })} />
          {orderId ? <input type="hidden" name="orderId" value={orderId} /> : null}
          {pkgs.map((p) => <input key={p} type="hidden" name="pkg" value={p} />)}
          {tests.map((t) => <input key={t} type="hidden" name="test" value={t} />)}
          {!ordered ? (
            <fieldset className="mc-fieldset"><legend>For</legend><div className="mc-radios">
              {family.map((p, i) => <label key={p.id} className="mc-radio"><input type="radio" name="patientId" value={p.id} defaultChecked={i === 0} required /><span>{p.fullName} <span className="mc-meta">({p.isSelf ? 'you' : p.relation.toLowerCase()})</span></span></label>)}
            </div></fieldset>
          ) : <p className="mc-meta">For {ordered.patient.name}</p>}
          {atHome ? (
            <fieldset className="mc-fieldset"><legend>Address ({pincode})</legend>
              <div className="mc-form">
                <Field label="House / flat, street" name="line1" required defaultValue={addr?.line1 ?? ''} />
                <Field label="Area" name="line2" defaultValue={addr?.line2 ?? ''} />
                <Field label="Landmark" name="landmark" defaultValue={addr?.landmark ?? ''} />
                <Field label="City" name="city" defaultValue={addr?.city ?? ''} />
                <Field label="Phone for the collector" name="phone" required type="tel" defaultValue={addr?.phone ?? ''} placeholder="+91…" />
              </div>
            </fieldset>
          ) : null}
          <fieldset className="mc-fieldset"><legend>Time</legend>
            {slots.length ? <div className="mc-times" role="radiogroup" aria-label="Times">
              {slots.map((s) => <label key={s.slotAt} className="mc-radio"><input type="radio" name="slotAt" value={s.slotAt} required /><span>{s.localTime} <span className="mc-meta">({s.left} left)</span></span></label>)}
            </div> : <p className="mc-empty">No free times this day; pick another day.</p>}
            {atHome ? <p className="mc-meta">The collector arrives within the half hour you pick.</p> : null}
          </fieldset>
          {online ? (
            <fieldset className="mc-fieldset"><legend>Payment</legend><div className="mc-radios">
              <label className="mc-radio"><input type="radio" name="paymentMode" value="ONLINE" defaultChecked /><span>Pay ₹{total + fee} now</span></label>
              <label className="mc-radio"><input type="radio" name="paymentMode" value="AT_CLINIC" /><span>{atHome ? 'Pay the collector at home' : 'Pay at the lab'}</span></label>
            </div></fieldset>
          ) : <input type="hidden" name="paymentMode" value="AT_CLINIC" />}
          <Button>{online ? 'Continue' : 'Book'}</Button>
        </form>
      </Card>
      </>)}
    </ZoneFrame>
  );
}
