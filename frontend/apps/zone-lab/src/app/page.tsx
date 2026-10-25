import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { isReadOnly, ReadOnlyNotice } from '@mc/features/plan';
import { Badge, Button, Card, Chip, Field, PageHeader } from '@mc/ui';
import { randomUUID } from 'node:crypto';
import { collectPayment, reject, scan } from '@/lib/actions';
import { markPerformed } from '@/lib/performed-action';
import { Flash } from '@/lib/flash';
import { age, barcodeSvg, type LabOrder, STATUS, type Worklist } from '@/lib/lab';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const fmtDay = (d: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function OrderCard({ o, back, canCollect, canPay }: { o: LabOrder; back: string; canCollect: boolean; canPay: boolean }) {
  const s = STATUS[o.status] ?? { label: o.status.toLowerCase(), tone: 'neutral' as const };
  const unpaid = o.paymentStatus === 'UNPAID' && o.total > 0;
  return (
    <article className="mc-card" aria-label={`Lab order ${o.orderNo}`} data-testid={`lab-${o.orderNo}`}>
      <h3 style={{ marginTop: 0 }}>
        {o.localTime} · {o.patient.name} <span className="mc-meta">{o.patient.mrn} · {age(o.patient.dob) ?? '?'} y{o.patient.gender ? ` · ${o.patient.gender[0]}` : ''} · {o.orderNo}</span>{' '}
        <Badge tone={s.tone}>{s.label}</Badge>{' '}
        <Badge tone={unpaid ? 'danger' : 'success'}>{unpaid ? `₹${o.total} due` : o.paymentStatus === 'NOT_DUE' ? 'no charge' : 'paid'}</Badge>
        {o.collectionType === 'HOME' ? <>{' '}<Badge tone="neutral">{`home collection${o.homeVisit?.phlebotomistName ? ` · ${o.homeVisit.phlebotomistName}` : ''}`}</Badge></> : null}
      </h3>
      <p className="mc-meta" style={{ margin: 0 }}>{o.lines.map((l) => l.name).join(' + ')}{o.orderedBy ? ` · ordered by ${o.orderedBy.name}` : ''}</p>
      {o.preparation ? <p className="mc-meta" style={{ margin: '4px 0 0' }}>Preparation: {o.preparation}</p> : null}
      {o.note ? <p className="mc-meta" style={{ margin: '4px 0 0' }}>Note: {o.note}</p> : null}
      {unpaid && canPay && o.status !== 'CANCELLED' && o.collectionType !== 'HOME' ? (
        <form action={collectPayment} className="mc-inline" style={{ marginTop: 8 }} aria-label={`Collect payment for ${o.orderNo}`}>
          <input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <select name="method" aria-label="Method" className="mc-select-sm" defaultValue="CASH"><option value="CASH">Cash</option><option value="UPI">UPI</option><option value="CARD">Card</option></select>
          <input name="reference" aria-label="Reference" placeholder="Ref (UPI/card)" className="mc-input-sm" />
          <Button>{`Collect ₹${o.total}`}</Button>
        </form>
      ) : null}
      {o.samples.length ? (
        <div className="mc-table-wrap" style={{ marginTop: 8 }}>
          <table className="mc-table">
            <thead><tr><th>Label</th><th>Sample</th><th>Status</th><th /></tr></thead>
            <tbody>
              {o.samples.map((x) => (
                <tr key={x.id} data-barcode={x.barcode}>
                  <td><span style={{ display: 'inline-block', width: 150 }} dangerouslySetInnerHTML={{ __html: barcodeSvg(x.barcode) }} /></td>
                  <td>{x.sampleType.toLowerCase()}<br /><span className="mc-meta">{x.container}</span></td>
                  <td>{x.status.toLowerCase()}{x.collectedBy ? <><br /><span className="mc-meta">by {x.collectedBy}</span></> : null}{x.rejectedReason ? <><br /><span className="mc-meta">{x.rejectedReason}</span></> : null}</td>
                  <td>
                    {canCollect && ['COLLECTED', 'RECEIVED'].includes(x.status) && !['RESULTS_ENTERED', 'REPORT_PUBLISHED'].includes(o.status) ? (
                      <form action={reject} className="mc-inline">
                        <input type="hidden" name="barcode" value={x.barcode} /><input type="hidden" name="back" value={back} />
                        <input name="reason" aria-label={`Reject reason for ${x.barcode}`} placeholder="haemolysed, too little…" className="mc-input-sm" required minLength={3} />
                        <Button variant="ghost">Reject</Button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <p className="mc-meta" style={{ margin: 0 }}>No samples: the test is done at the lab (X-ray, ECG…).</p>
          {canCollect && o.status === 'BOOKED' && !unpaid ? (
            <form action={markPerformed} className="mc-inline" style={{ marginTop: 6 }}>
              <input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="back" value={back} />
              <Button>Patient seen: write the report</Button>
            </form>
          ) : null}
        </div>
      )}
      <p style={{ margin: '8px 0 0' }}>
        <a href={`/lab/labels?orderId=${o.id}`} target="_blank">Print labels</a>
        {['IN_LAB', 'RESULTS_ENTERED', 'REPORT_PUBLISHED'].includes(o.status) ? <> · <a href={`/lab/orders/${o.id}`}>{o.status === 'IN_LAB' ? 'Enter results' : o.status === 'RESULTS_ENTERED' ? 'Review and verify' : 'Report'}</a></> : null}
      </p>
    </article>
  );
}

/** Today's lab: who comes when, what to draw (labels with barcodes), take payment, scan tubes in. */
export default async function Worklist({ searchParams }: { searchParams: Promise<{ branch?: string; date?: string; ok?: string; error?: string; step?: string }> }) {
  const caps = await zoneCapabilities('lab', '/lab');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const branches = await api<{ id: string; name: string }[]>('/api/diagnostics/v1/public/lab-branches', { token });
  const branch = branches.find((b) => b.id === sp.branch) ?? branches.find((b) => b.name === 'Sector 44') ?? branches[0];
  const wl = branch ? await api<Worklist>(`/api/diagnostics/v1/lab/worklist?branchId=${branch.id}${sp.date ? `&date=${sp.date}` : ''}`, { token }) : null;
  const q = (x: Record<string, string>) => `/lab?${new URLSearchParams({ ...(branch ? { branch: branch.id } : {}), ...(sp.date ? { date: sp.date } : {}), ...x })}`;
  const back = q({});
  const canCollect = can(caps, 'sample:collect:branch');
  return (
    <ZoneFrame zone="lab" path="/lab" zones={ZONES}>
      <PageHeader title="Lab worklist" subtitle={wl ? `${wl.branch.name} · ${fmtDay(wl.date)}` : undefined} actions={wl ? <>
        <a className="mc-btn mc-btn-ghost" href={q({ date: shift(wl.date, -1) })}>← Previous day</a>
        <a className="mc-btn mc-btn-ghost" href={q({ date: shift(wl.date, 1) })}>Next day →</a>
      </> : null} />
      <ReadOnlyNotice caps={caps} module="diagnostics" />
      <Flash ok={sp.ok} error={sp.error} />
      {branches.length > 1 ? <div className="mc-chips">{branches.map((b) => <Chip key={b.id} href={`/lab?branch=${b.id}`} active={b.id === branch?.id}>{b.name}</Chip>)}</div> : null}
      {canCollect ? (
        <Card title="Scan a tube">
          <form action={scan} className="mc-form" aria-label="Scan">
            <input type="hidden" name="back" value={back} />
            <Field label="Barcode" name="barcode" required placeholder="Scan or type, e.g. S00001234" autoComplete="off" />
            <label className="mc-field"><span>Step</span>
              <select name="step" defaultValue={sp.step === 'receive' ? 'receive' : 'collect'}><option value="collect">Collected from patient</option><option value="receive">Received at the lab bench</option></select>
            </label>
            <Button>Record</Button>
          </form>
        </Card>
      ) : null}
      {wl ? (
        <>
          <div className="mc-grid">
            {([['To collect', wl.totals.booked], ['Collected', wl.totals.collected], ['In lab', wl.totals.inLab], ['Recollect', wl.totals.rejected]] as const).map(([label, n]) => (
              <Card key={label}><p className="mc-muted" style={{ margin: 0 }}>{label}</p><p className="mc-stat">{n}</p></Card>
            ))}
          </div>
          {wl.orders.length ? wl.orders.map((o) => <OrderCard key={o.id} o={o} back={back} canCollect={canCollect} canPay={can(caps, 'payment:collect:branch') && !isReadOnly(caps, 'diagnostics')} />) : <Card><p className="mc-empty">No lab bookings for this day.</p></Card>}
        </>
      ) : <Card><p className="mc-muted">No lab branches.</p></Card>}
    </ZoneFrame>
  );
}
