import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { Flash } from '@/lib/flash';
import { addressLine, type HomeVisit, VISIT } from '@/lib/home';
import { collectAtHome, payAtHome, visitStep } from '@/lib/home-actions';
import { barcodeSvg } from '@/lib/lab';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const fmtDay = (d: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

function Step({ v, step, label, variant }: { v: HomeVisit; step: string; label: string; variant?: 'ghost' | 'danger' }) {
  return <form action={visitStep} className="mc-inline"><input type="hidden" name="visitId" value={v.id} /><input type="hidden" name="step" value={step} /><input type="hidden" name="back" value="/lab/visits" /><Button variant={variant}>{label}</Button></form>;
}

/** The phlebotomist's day, on a phone: where to go, what to draw, take payment, scan each tube. */
function VisitCard({ v }: { v: HomeVisit }) {
  const o = v.order!;
  const due = v.paymentStatus === 'UNPAID' && v.total > 0;
  const s = VISIT[v.status] ?? { label: v.status, tone: 'neutral' as const };
  const pending = o.samples.filter((x) => x.status === 'PENDING');
  return (
    <article className="mc-card" aria-label={`Visit ${v.orderNo}`}>
      <h3 style={{ marginTop: 0 }}>{v.localTime} · {v.patient.name} <Badge tone={s.tone}>{s.label}</Badge></h3>
      <p style={{ margin: 0 }}>{addressLine(v.address)}</p>
      {v.address?.phone ? <p style={{ margin: '4px 0 0' }}><a href={`tel:${v.address.phone}`}>Call {v.address.phone}</a></p> : null}
      <p className="mc-meta" style={{ margin: '4px 0 0' }}>{v.orderNo} · {o.lines.filter((l) => l.kind !== 'HOME_VISIT').map((l) => l.name).join(' + ')}</p>
      {o.preparation ? <p className="mc-meta" style={{ margin: '4px 0 0' }}>Preparation: {o.preparation}</p> : null}
      {v.status === 'ASSIGNED' ? <p className="mc-inline" style={{ marginTop: 8 }}><Step v={v} step="start" label="On my way" /></p> : null}
      {v.status === 'EN_ROUTE' ? <p className="mc-inline" style={{ marginTop: 8 }}><Step v={v} step="arrive" label="Arrived" /></p> : null}
      {v.status === 'ARRIVED' && due ? (
        <form action={payAtHome} className="mc-inline" style={{ marginTop: 8 }} aria-label={`Payment for ${v.orderNo}`}>
          <input type="hidden" name="visitId" value={v.id} /><input type="hidden" name="orderId" value={v.orderId} /><input type="hidden" name="back" value="/lab/visits" /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <select name="method" aria-label="Method" className="mc-select-sm" defaultValue="UPI"><option value="UPI">UPI</option><option value="CASH">Cash</option><option value="CARD">Card</option></select>
          <input name="reference" aria-label="Reference" placeholder="UPI ref" className="mc-input-sm" />
          <Button>{`Take ₹${v.total}`}</Button>
        </form>
      ) : null}
      {v.status === 'ARRIVED' && !due && pending.length ? (
        <form action={collectAtHome} className="mc-form" style={{ marginTop: 8 }} aria-label={`Collect for ${v.orderNo}`}>
          <input type="hidden" name="visitId" value={v.id} /><input type="hidden" name="back" value="/lab/visits" />
          <Field label="Tube barcode" name="barcode" required placeholder="Scan the label" autoComplete="off" />
          <Button>Collected</Button>
        </form>
      ) : null}
      <div className="mc-table-wrap" style={{ marginTop: 8 }}>
        <table className="mc-table">
          <thead><tr><th>Label</th><th>Tube</th><th>Status</th></tr></thead>
          <tbody>{o.samples.map((x) => (
            <tr key={x.id} data-barcode={x.barcode}>
              <td><span style={{ display: 'inline-block', width: 150 }} dangerouslySetInnerHTML={{ __html: barcodeSvg(x.barcode) }} /></td>
              <td>{x.sampleType.toLowerCase()}<br /><span className="mc-meta">{x.container}</span></td>
              <td>{x.status.toLowerCase()}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {v.status === 'COLLECTED' ? <p className="mc-muted">Take the tubes to the {v.branch.name} lab; the lab's scan completes the hand-over.</p> : null}
      {['ASSIGNED', 'EN_ROUTE', 'ARRIVED'].includes(v.status) && !o.samples.some((x) => x.status === 'COLLECTED') ? (
        <details style={{ marginTop: 8 }}><summary>Could not collect</summary>
          <form action={visitStep} className="mc-inline" style={{ marginTop: 8 }}>
            <input type="hidden" name="visitId" value={v.id} /><input type="hidden" name="step" value="miss" /><input type="hidden" name="back" value="/lab/visits" />
            <input name="reason" aria-label={`Reason for ${v.orderNo}`} placeholder="not at home, not fasting…" className="mc-input-sm" style={{ width: 220 }} required minLength={3} />
            <Button variant="danger">Missed</Button>
          </form>
        </details>
      ) : null}
    </article>
  );
}

export default async function MyVisits({ searchParams }: { searchParams: Promise<{ date?: string; ok?: string; error?: string }> }) {
  await zoneCapabilities('lab', '/lab/visits');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const day = await api<{ date: string; visits: HomeVisit[] }>(`/api/diagnostics/v1/home-visits/mine${sp.date ? `?date=${sp.date}` : ''}`, { token });
  const open = day.visits.filter((v) => !['COLLECTED', 'HANDED_OVER', 'MISSED'].includes(v.status));
  const done = day.visits.filter((v) => ['COLLECTED', 'HANDED_OVER', 'MISSED'].includes(v.status));
  return (
    <ZoneFrame zone="lab" path="/lab/visits" zones={ZONES}>
      <PageHeader title="My visits" subtitle={`${fmtDay(day.date)} · ${open.length} to go`} />
      <Flash ok={sp.ok} error={sp.error} />
      {!day.visits.length ? <Card><p className="mc-empty">No home visits for you this day.</p></Card> : null}
      {open.map((v) => <VisitCard key={v.id} v={v} />)}
      {done.length ? <h2 className="mc-section-title">Done</h2> : null}
      {done.map((v) => <VisitCard key={v.id} v={v} />)}
    </ZoneFrame>
  );
}
