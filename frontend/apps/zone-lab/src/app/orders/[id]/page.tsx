import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { ReadOnlyNotice } from '@mc/features/plan';
import { Alert, Badge, Button, Card, Field, PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { amendReport, saveResults, verifyReport } from '@/lib/result-actions';
import { Flash } from '@/lib/flash';
import { age, FLAG, refRange, type Sheet, STATUS } from '@/lib/lab';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : '—');

/** One order at the bench: enter results (flags appear as you save), verify and publish, amend after publishing. */
export default async function OrderResults({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const path = `/lab/orders/${id}`;
  const caps = await zoneCapabilities('lab', path);
  const { accessToken: token } = (await getSession())!;
  const s = await api<Sheet>(`/api/diagnostics/v1/lab/orders/${encodeURIComponent(id)}/results`, { token }).catch((e) => (e instanceof ApiError && e.status === 404 ? notFound() : Promise.reject(e)));
  const o = s.order;
  const published = o.status === 'REPORT_PUBLISHED';
  const canEnter = can(caps, 'result:enter:branch') && ['IN_LAB', 'RESULTS_ENTERED'].includes(o.status);
  const canVerify = can(caps, 'report:verify:branch');
  const current = s.reports.find((r) => !r.superseded);
  const st = STATUS[o.status] ?? { label: o.status.toLowerCase().replace('_', ' '), tone: 'neutral' as const };
  const editable = canEnter || (published && canVerify);
  return (
    <ZoneFrame zone="lab" path={path} zones={ZONES}>
      <PageHeader title={`${o.patient.name} · ${o.orderNo}`} subtitle={`${o.patient.mrn} · ${age(o.patient.dob) ?? '?'} y${o.patient.gender ? ` · ${o.patient.gender.toLowerCase()}` : ''}${o.orderedBy ? ` · ordered by ${o.orderedBy.name}` : ''} · collected ${when(s.collectedAt)} · due ${when(s.dueAt)}`}
        actions={<><Badge tone={st.tone}>{st.label}</Badge>{s.overdue ? <Badge tone="danger">overdue</Badge> : null}<a className="mc-btn mc-btn-ghost" href="/lab/pending">Pending results</a></>} />
      <ReadOnlyNotice caps={caps} module="diagnostics" />
      <Flash {...await searchParams} />
      {s.tests.some((t) => t.parameters.some((p) => p.critical && !p.acknowledged)) ? <Alert tone="error">Critical value{o.orderedBy ? `: ${o.orderedBy.name} has been alerted` : ': call the patient / their doctor and acknowledge it on Pending results'}.</Alert> : null}
      <form action={published ? amendReport : saveResults}>
        <input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="back" value={path} />
        {s.tests.map((t) => (
          <Card key={t.itemId} title={t.name}>
            <div className="mc-table-wrap">
              <table className="mc-table">
                <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th><th>Flag</th></tr></thead>
                <tbody>
                  {t.parameters.map((p) => (
                    <tr key={p.parameter}>
                      <td>{p.parameter}</td>
                      <td>{editable
                        ? <input name={`v:${t.itemId}:${p.parameter}`} defaultValue={p.value ?? ''} aria-label={`${t.name} ${p.parameter}`} className="mc-input-sm" placeholder={p.refLow == null && p.refHigh == null && p.parameter === 'Result' ? 'Negative / Positive' : ''} />
                        : (p.value ?? '—')}</td>
                      <td className="mc-meta">{p.unit}</td>
                      <td className="mc-meta">{refRange(p.refLow, p.refHigh)}</td>
                      <td>{p.flag ? <Badge tone={FLAG[p.flag]?.tone ?? 'neutral'}>{FLAG[p.flag]?.label ?? p.flag}</Badge> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
        {canEnter ? <p><Button>Save results</Button></p> : null}
        {published && canVerify ? (
          <Card title="Amend the published report">
            <p className="mc-muted" style={{ marginTop: 0 }}>Change the values above, give the reason, and publish a new version. The current version is kept and marked superseded.</p>
            <div className="mc-form"><Field label="Reason" name="reason" required placeholder="e.g. transcription error" /><Button variant="danger">Publish amended report</Button></div>
          </Card>
        ) : null}
      </form>
      {o.status === 'RESULTS_ENTERED' && canVerify ? (
        <Card title="Verify">
          <form action={verifyReport}><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="back" value={path} /><Button>Verify and publish report</Button></form>
        </Card>
      ) : null}
      {s.reports.length ? (
        <Card title="Reports">
          {s.reports.map((r) => (
            <p key={r.id}>
              Version {r.version} · verified by {r.verifiedBy} {when(r.verifiedAt)} · {r.abnormal} abnormal, {r.critical} critical
              {r.superseded ? <> · <Badge>superseded</Badge></> : null}{r.amendmentReason ? ` · amended: ${r.amendmentReason}` : ''} · code {r.verifyCode}
            </p>
          ))}
          {current ? <a className="mc-btn mc-btn-ghost" href={`/lab/orders/${o.id}/report`}>Open report PDF</a> : null}
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
