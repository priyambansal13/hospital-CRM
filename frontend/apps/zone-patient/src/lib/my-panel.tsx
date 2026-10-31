import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { Icon, Kpi } from '@mc/ui';
import { type Invoice, myInvoices } from './billing';

interface Appt { id: string; status: string; localDate: string; localTime: string; doctor: { name: string }; branch: { name: string }; patient: { name: string }; appointmentNo: string; mode: string }
const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;
const day = (d: string) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + 86_400_000));
  return d === today ? 'Today' : d === tomorrow ? 'Tomorrow' : new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
};

/** A signed-in patient's own corner of the home page: the next visit, reports ready, bills to pay, shortcuts. */
export async function MyPanel() {
  const session = await getSession();
  if (session?.kind !== 'patient') return null;
  const token = session.accessToken;
  const [me, appts, orders, bills] = await Promise.all([
    soft(api<{ fullName: string; isSelf: boolean }[]>('/api/patient/v1/me/patients', { token }), []),
    soft(api<{ upcoming: Appt[] }>('/api/scheduling/v1/me/appointments', { token }), { upcoming: [] }),
    soft(api<{ status: string }[]>('/api/diagnostics/v1/me/lab-orders', { token }), []),
    soft(myInvoices(token), [] as Invoice[]),
  ]);
  const name = me.find((p) => p.isSelf)?.fullName?.split(' ')[0];
  const next = appts.upcoming[0];
  const ready = orders.filter((o) => o.status === 'REPORT_PUBLISHED').length;
  const due = bills.filter((b) => b.status === 'ISSUED' && b.paymentMode === 'ONLINE');
  return (
    <section aria-label="Your care" style={{ display: 'grid', gap: 16 }}>
      <div className="mc-band" style={{ margin: 0, padding: 0 }}>
        <div className="mc-band-inner">
          <div>
            <h2>{name ? `Hello, ${name}` : 'Hello'}</h2>
            {next ? (
              <p><strong>{day(next.localDate)}, {next.localTime}</strong> with {next.doctor.name} at {next.branch.name}{next.patient.name && name && !next.patient.name.startsWith(name) ? ` (for ${next.patient.name})` : ''} · {next.appointmentNo}</p>
            ) : <p>No visits booked. Find a doctor below, or ask our assistant.</p>}
          </div>
          <div className="mc-actions">
            {next ? <a className="mc-btn mc-btn-ghost mc-btn-lg" href="/care/appointments">My appointments</a> : null}
            <a className="mc-btn mc-btn-ghost mc-btn-lg" href="/care/assistant"><Icon name="chat" size={18} />Ask us</a>
          </div>
        </div>
      </div>
      <div className="mc-kpis">
        <Kpi label="Upcoming visits" icon="calendar" value={appts.upcoming.length} sub={next ? `Next: ${day(next.localDate)}` : 'Book one below'} href="/care/appointments" />
        <Kpi label="Reports ready" icon="file" tone={ready ? 'success' : undefined} value={ready} sub={ready ? 'Open them in My lab tests' : 'Nothing new'} href="/care/lab-orders" />
        <Kpi label="To pay online" icon="receipt" tone={due.length ? 'warning' : undefined} value={due.length ? inr(due.reduce((n, b) => n + b.total - b.amountPaid, 0)) : '₹0'} sub={due.length ? `${due.length} bill${due.length === 1 ? '' : 's'}` : 'All settled'} href="/care/bills" />
        <Kpi label="Health record" icon="clipboard" value={<Icon name="arrow" size={26} />} sub="Visits, prescriptions, reports" href="/care/timeline" />
      </div>
    </section>
  );
}
