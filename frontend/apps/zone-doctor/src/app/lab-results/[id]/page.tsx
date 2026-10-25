import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame } from '@mc/features';
import { Alert, Badge, Card, PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { Flash } from '@/lib/flash';
import { FLAG, refRange, type ResultSheet, STATUS, when } from '@/lib/lab';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** One order's results for a doctor with access (treating/consent). Before verification only critical values are shown. */
export default async function OrderResults({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const { accessToken: token } = (await getSession())!;
  const s = await api<ResultSheet>(`/api/diagnostics/v1/doctor/lab-orders/${encodeURIComponent(id)}/results`, { token })
    .catch((e) => (e instanceof ApiError && (e.status === 404 || e.status === 403) ? notFound() : Promise.reject(e)));
  const published = s.order.status === 'REPORT_PUBLISHED';
  const current = s.reports.find((r) => !r.superseded);
  return (
    <ZoneFrame zone="doctor" path="/doctor/lab-results" zones={ZONES}>
      <PageHeader title={`${s.order.patient.name} · ${s.order.orderNo}`} subtitle={`${s.order.patient.mrn}${current ? ` · verified by ${current.verifiedBy} ${when(current.verifiedAt)}${current.version > 1 ? ` · version ${current.version}` : ''}` : ''}`}
        actions={<>{published ? <a className="mc-btn mc-btn-primary" href={`/doctor/lab-results/${s.order.id}/report`}>Report PDF</a> : null}<a className="mc-btn mc-btn-ghost" href="/doctor/lab-results">All lab results</a></>} />
      <Flash {...await searchParams} />
      {!published ? <Alert tone="info">Status: {STATUS[s.order.status] ?? s.order.status}. Values appear once the pathologist verifies the report; critical values are shown straight away.</Alert> : null}
      {current?.amendmentReason ? <Alert tone="info">Amended report: {current.amendmentReason}</Alert> : null}
      {s.tests.map((t) => (
        <Card key={t.itemId} title={t.name}>
          <div className="mc-table-wrap">
            <table className="mc-table">
              <thead><tr><th>Parameter</th><th>Result</th><th>Reference</th><th>Flag</th></tr></thead>
              <tbody>
                {t.parameters.map((p) => (
                  <tr key={p.parameter}>
                    <td>{p.parameter}</td>
                    <td>{p.value != null ? <strong>{p.value}</strong> : <span className="mc-meta">pending</span>} <span className="mc-meta">{p.unit}</span></td>
                    <td className="mc-meta">{refRange(p.refLow, p.refHigh)}</td>
                    <td>{p.flag ? <Badge tone={FLAG[p.flag]?.tone ?? 'neutral'}>{FLAG[p.flag]?.label ?? p.flag}</Badge> : null}{p.critical && p.acknowledged ? <span className="mc-meta"> acknowledged</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      {s.tests.some((t) => t.parameters.some((p) => p.critical && !p.acknowledged)) ? <p><a className="mc-btn mc-btn-danger" href="/doctor/lab-results">Acknowledge critical values</a></p> : null}
    </ZoneFrame>
  );
}
