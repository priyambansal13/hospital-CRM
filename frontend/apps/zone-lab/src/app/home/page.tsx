import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { branchesFor, ZoneFrame, zoneCapabilities } from '@mc/features';
import { isReadOnly, ReadOnlyNotice } from '@mc/features/plan';
import { Badge, Button, Card, Chip, iconFor, Kpi, PageHeader, Table } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { addressLine, type Board, VISIT } from '@/lib/home';
import { assignVisit } from '@/lib/home-actions';
import { visitMissed } from '@/lib/book-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const fmtDay = (d: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The day's home collections at a branch: who goes where, and how each visit is going. */
export default async function HomeBoard({ searchParams }: { searchParams: Promise<{ branch?: string; date?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('lab', '/lab/home');
  const readOnly = isReadOnly(caps, 'home_collection') || isReadOnly(caps, 'diagnostics');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  // only the branches this person works at, their own first (review B-1)
  const branches = branchesFor(caps, 'home_visit:assign:branch', await api<{ id: string; name: string }[]>('/api/diagnostics/v1/public/lab-branches', { token }));
  const branch = branches.find((b) => b.id === sp.branch) ?? (caps.branchIds ? branches[0] : branches.find((b) => b.name === 'Sector 44')) ?? branches[0];
  const board = branch ? await api<Board>(`/api/diagnostics/v1/lab/home-visits?branchId=${branch.id}${sp.date ? `&date=${sp.date}` : ''}`, { token }) : null;
  const q = (x: Record<string, string>) => `/lab/home?${new URLSearchParams({ ...(branch ? { branch: branch.id } : {}), ...(sp.date ? { date: sp.date } : {}), ...x })}`;
  const back = q({});
  return (
    <ZoneFrame zone="lab" path="/lab/home" zones={ZONES}>
      <PageHeader title="Home collections" subtitle={board ? `${board.branch.name} · ${fmtDay(board.date)}` : undefined} actions={board ? <>
        <a className="mc-btn mc-btn-ghost" href={q({ date: shift(board.date, -1) })}>← Previous day</a>
        <a className="mc-btn mc-btn-ghost" href={q({ date: shift(board.date, 1) })}>Next day →</a>
      </> : null} />
      <ReadOnlyNotice caps={caps} module="home_collection" />
      <Flash ok={sp.ok} error={sp.error} />
      {branches.length > 1 ? <div className="mc-chips">{branches.map((b) => <Chip key={b.id} href={`/lab/home?branch=${b.id}${sp.date ? `&date=${sp.date}` : ''}`} active={b.id === branch?.id}>{b.name}</Chip>)}</div> : null}
      {board ? (
        <>
          <div className="mc-grid">
            {([['Overdue', board.totals.overdue ?? 0], ['To assign', board.totals.unassigned], ['Assigned', board.totals.assigned], ['Out now', board.totals.out], ['Collected', board.totals.collected], ['Missed', board.totals.missed]] as const).map(([label, n]) => (
              <Kpi key={label} label={label} value={n} icon={iconFor('', label)} />
            ))}
          </div>
          <Card title="Visits">
            <Table rows={board.visits} empty="No home collections this day." columns={[
              { header: 'Time', cell: (v) => <strong>{v.localTime}</strong> },
              { header: 'Patient', cell: (v) => <>{v.patient.name} <span className="mc-meta">{v.patient.mrn} · {v.orderNo}</span></> },
              { header: 'Address', cell: (v) => <span className="mc-meta">{addressLine(v.address)}</span> },
              { header: 'Payment', cell: (v) => <Badge tone={v.paymentStatus === 'PAID' || v.paymentStatus === 'NOT_DUE' ? 'success' : 'warning'}>{v.paymentStatus === 'PAID' ? 'paid' : v.paymentStatus === 'NOT_DUE' ? 'no charge' : `₹${v.total} at home`}</Badge> },
              { header: 'Status', cell: (v) => <><Badge tone={VISIT[v.status]?.tone ?? 'neutral'}>{VISIT[v.status]?.label ?? v.status}</Badge>{v.phlebotomist ? <span className="mc-meta"> {v.phlebotomist.name}</span> : null}{v.missedReason ? <span className="mc-meta"> · {v.missedReason}</span> : null}</> },
              { header: '', cell: (v) => (!readOnly && ['UNASSIGNED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED'].includes(v.status) && v.orderStatus === 'BOOKED' ? (
                <span className="mc-inline">
                {v.overdue ? <Badge tone="danger">overdue</Badge> : null}
                <form action={assignVisit} className="mc-inline" aria-label={`Assign ${v.orderNo}`}>
                  <input type="hidden" name="visitId" value={v.id} /><input type="hidden" name="back" value={back} />
                  <select name="phlebotomistId" aria-label="Phlebotomist" className="mc-select-sm" defaultValue={v.phlebotomist?.id ?? ''} required>
                    <option value="" disabled>Choose…</option>
                    {board.phlebotomists.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.visits})</option>)}
                  </select>
                  <Button>{v.phlebotomist ? 'Reassign' : 'Assign'}</Button>
                </form>
                {/* D-10: the visit cannot happen (nobody free, the patient called, the collector cannot finish) */}
                <form action={visitMissed} className="mc-inline" aria-label={`Cannot visit ${v.orderNo}`}>
                  <input type="hidden" name="id" value={v.id} /><input type="hidden" name="back" value={back} />
                  <input name="reason" required minLength={3} placeholder="Why not" aria-label="Why the visit cannot happen" className="mc-input-sm" />
                  <Button variant="ghost">Cannot visit</Button>
                </form>
                </span>
              ) : null) },
            ]} />
            {!board.phlebotomists.length ? <p className="mc-muted">No phlebotomists yet: add staff with the Phlebotomist role in Admin → Staff.</p> : null}
          </Card>
        </>
      ) : <Card><p className="mc-muted">No lab branches.</p></Card>}
    </ZoneFrame>
  );
}
