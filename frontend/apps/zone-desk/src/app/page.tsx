import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Chip, PageHeader, Table } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { LiveRefresh } from '@mc/ui/live';
import { cancel, checkIn, collectPayment, noShow } from '@/lib/actions';
import { type Appt, type Board, branches, chatSummary, STATUS, triageSummary } from '@/lib/desk';
import { ChatAlert } from '@/lib/chat-alert';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

function Act({ action, id, label, back, variant = 'ghost' }: { action: (f: FormData) => Promise<void>; id: string; label: string; back: string; variant?: 'primary' | 'ghost' | 'danger' }) {
  return (
    <form action={action} className="mc-inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="back" value={back} />
      <Button variant={variant}>{label}</Button>
    </form>
  );
}

/** Today at one branch: every doctor's patients, check-in with token numbers, live as things change. */
export default async function DeskBoard({ searchParams }: { searchParams: Promise<{ branch?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('desk', '/desk');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const { all, current } = await branches(token, sp.branch, caps);
  const board = current ? await api<Board>(`/api/scheduling/v1/desk/board?branchId=${current.id}`, { token }) : null;
  const back = current ? `/desk?branch=${current.id}` : '/desk';
  const chats = await chatSummary(token, caps);
  // nurses: vitals and triage for patients waiting (checked in)
  const canTriage = can(caps, 'vitals:record:branch') && caps.modules.includes('emr');
  const triage = canTriage && board ? await triageSummary(token, caps, board.doctors.flatMap((d) => d.appointments.filter((a) => ['CHECKED_IN', 'IN_PROGRESS'].includes(a.status)).map((a) => a.id))) : {};
  const PRIORITY = { ROUTINE: { label: 'routine', tone: 'neutral' }, URGENT: { label: 'urgent', tone: 'warning' }, EMERGENCY: { label: 'emergency', tone: 'danger' } } as const;
  const canBook = can(caps, 'walkin:create:branch');
  const canCancel = can(caps, 'appointment:cancel:branch');
  const canCollect = can(caps, 'payment:collect:branch');
  const payment = (a: Appt) => {
    if (!a.fee || a.paymentStatus === 'NOT_DUE') return <span className="mc-muted">—</span>;
    if (a.paymentStatus === 'PAID') return <Badge tone="success">{a.paymentMode === 'ONLINE' ? 'paid online' : 'paid'}</Badge>;
    if (a.paymentStatus !== 'UNPAID') return <Badge>{a.paymentStatus.toLowerCase().replace('_', ' ')}</Badge>;
    if (!canCollect || ['CANCELLED', 'NO_SHOW'].includes(a.status)) return <span>₹{a.fee} due</span>;
    return (
      <form action={collectPayment} className="mc-inline" aria-label={`Collect payment for ${a.patient.name}`}>
        <input type="hidden" name="id" value={a.id} />
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <select name="method" aria-label="Method" defaultValue="CASH" className="mc-select-sm">
          <option value="CASH">Cash</option><option value="UPI">UPI</option><option value="CARD">Card</option>
        </select>
        <input name="reference" placeholder="Ref (UPI/card)" aria-label="Reference" className="mc-input-sm" />
        <Button>{`Collect ₹${a.fee}`}</Button>
      </form>
    );
  };
  const due = (a: Appt) => Date.parse(a.startsAt) <= Date.now();
  const fmtDay = (d: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

  return (
    <ZoneFrame zone="desk" path="/desk" zones={ZONES}>
      <PageHeader
        title="Front desk"
        subtitle={board ? `${board.branch.name} · ${fmtDay(board.date)}` : undefined}
        actions={<>
          {current ? <LiveRefresh src={`/desk/live?branchId=${current.id}`} /> : null}
          {canBook && can(caps, 'patient:register:branch') ? <a className="mc-btn mc-btn-primary" href={`/desk/patients${current ? `?branch=${current.id}` : ''}`}>New walk-in</a> : null}
        </>}
      />
      <Flash ok={sp.ok} error={sp.error} />
      {chats ? <ChatAlert initial={chats} /> : null}
      {all.length > 1 ? <div className="mc-chips">{all.map((b) => <Chip key={b.id} href={`/desk?branch=${b.id}`} active={b.id === current?.id}>{b.name}</Chip>)}</div> : null}
      {!board ? <Card><p className="mc-muted">No active branches yet.</p></Card> : (
        <>
          <div className="mc-grid">
            {([['Booked today', board.totals.booked], ['Waiting', board.totals.waiting], ['With doctor', board.totals.inProgress], ['Done', board.totals.completed], ['No-show', board.totals.noShow]] as const).map(([label, n]) => (
              <Card key={label}><p className="mc-muted" style={{ margin: 0 }}>{label}</p><p className="mc-stat">{n}</p></Card>
            ))}
          </div>
          {board.doctors.map((d) => (
            <Card key={d.id} title={`${d.name} · ${d.appointments.filter((a) => a.status === 'CHECKED_IN').length} waiting`}>
              <Table
                rows={d.appointments}
                empty="No patients today."
                columns={[
                  { header: 'Token', cell: (a) => (a.tokenNo ? <span className="mc-token" aria-label={`Token ${a.tokenNo}`}>{a.tokenNo}</span> : <span className="mc-muted">—</span>) },
                  { header: 'Time', cell: (a) => (a.source === 'WALK_IN' ? 'walk-in' : a.localTime) },
                  { header: 'Patient', cell: (a) => <span data-testid={`desk-${a.appointmentNo}`}>{a.patient.name} <span className="mc-meta">{a.patient.mrn}</span></span> },
                  { header: 'Payment', cell: payment },
                  { header: 'Status', cell: (a) => <Badge tone={STATUS[a.status]?.tone ?? 'neutral'}>{a.mode === 'VIDEO' && a.status === 'CONFIRMED' ? 'video' : (STATUS[a.status]?.label ?? a.status.toLowerCase())}</Badge> },
                  {
                    header: '', cell: (a) => (
                      <span className="mc-inline">
                        {a.status === 'CONFIRMED' && a.mode !== 'VIDEO' ? <Act action={checkIn} id={a.id} back={back} label="Check in" variant="primary" /> : null}
                        {triage[a.id] ? <Badge tone={PRIORITY[triage[a.id].priority].tone}>{PRIORITY[triage[a.id].priority].label}</Badge> : null}
                        {canTriage && a.status === 'CHECKED_IN' ? <a className="mc-btn mc-btn-ghost" href={`/desk/triage/${a.id}?back=${encodeURIComponent(back)}`}>{triage[a.id] ? 'Vitals ✓' : 'Vitals'}</a> : null}
                        {(a.status === 'CONFIRMED' && due(a)) || a.status === 'CHECKED_IN' ? <Act action={noShow} id={a.id} back={back} label={a.status === 'CHECKED_IN' ? 'Left' : 'No-show'} /> : null}
                        {a.status === 'CONFIRMED' && canCancel ? <Act action={cancel} id={a.id} back={back} label="Cancel" /> : null}
                      </span>
                    ),
                  },
                ]}
              />
            </Card>
          ))}
          {!board.doctors.length ? <Card><p className="mc-muted">No doctors work at this branch yet.</p></Card> : null}
        </>
      )}
    </ZoneFrame>
  );
}
