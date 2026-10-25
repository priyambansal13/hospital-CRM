import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, Badge, Card, PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { FLAG, refRange, type ResultSheet } from '@/lib/lab';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** A verified lab report: values with the reference range and a plain-language flag, and the PDF. */
export default async function LabResults({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const path = '/care/lab-orders';
  const caps = await zoneCapabilities('patient', path);
  if (caps.actor.kind !== 'patient') return <ZoneFrame zone="patient" path={path} zones={ZONES}><Alert tone="error">This page is for patients.</Alert></ZoneFrame>;
  const { accessToken: token } = (await getSession())!;
  let s: ResultSheet;
  try {
    s = await api<ResultSheet>(`/api/diagnostics/v1/lab-orders/${encodeURIComponent(id)}/results`, { token });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    if (e instanceof ApiError && e.status === 409) return <ZoneFrame zone="patient" path={path} zones={ZONES}><Alert tone="info">Your results will appear here once the pathologist has checked them. We will send you a message.</Alert></ZoneFrame>;
    throw e;
  }
  const current = s.reports.find((r) => !r.superseded);
  const flagged = s.tests.flatMap((t) => t.parameters).filter((p) => p.flag && p.flag !== 'NORMAL').length;
  return (
    <ZoneFrame zone="patient" path={path} zones={ZONES}>
      <PageHeader title={`Lab report · ${s.order.orderNo}`}
        subtitle={`For ${s.order.patient.name}${current ? ` · checked by ${current.verifiedBy}` : ''}${current && current.version > 1 ? ` · updated report (version ${current.version})` : ''}`}
        actions={<><a className="mc-btn mc-btn-primary" href={`/care/lab-orders/${s.order.id}/report`}>Download report (PDF)</a><a className="mc-btn mc-btn-ghost" href="/care/lab-orders">My lab tests</a></>} />
      {current?.amendmentReason ? <Alert tone="info">This report was corrected after it was first issued ({current.amendmentReason}). Please use this version.</Alert> : null}
      <p className="mc-muted">{flagged ? `${flagged} value${flagged > 1 ? 's are' : ' is'} outside the usual range. Values outside the range are not always a problem; please discuss them with your doctor.` : 'All values are within the usual range.'}</p>
      {s.tests.map((t) => (
        <Card key={t.itemId} title={t.name}>
          <div className="mc-table-wrap">
            <table className="mc-table">
              <thead><tr><th>Test</th><th>Your result</th><th>Usual range</th><th></th></tr></thead>
              <tbody>
                {t.parameters.map((p) => (
                  <tr key={p.parameter}>
                    <td>{p.parameter}</td>
                    <td><strong>{p.value ?? '—'}</strong> <span className="mc-meta">{p.unit}</span></td>
                    <td className="mc-meta">{refRange(p.refLow, p.refHigh)} {refRange(p.refLow, p.refHigh) ? p.unit : ''}</td>
                    <td>{p.flag ? <Badge tone={FLAG[p.flag]?.tone ?? 'neutral'}>{FLAG[p.flag]?.label ?? p.flag}</Badge> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </ZoneFrame>
  );
}
