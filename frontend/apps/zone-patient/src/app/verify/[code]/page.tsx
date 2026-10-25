import { api, ApiError } from '@mc/bff';
import { ZoneFrame } from '@mc/features';
import { Alert, Card, PageHeader } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Verification { valid: boolean; hospital?: string; orderNo?: string; patient?: string; version?: number; verifiedBy?: string; verifiedAt?: string; current?: boolean; sha256?: string }

/** Behind the QR code on every report: is this a genuine report from this hospital, and is it the latest version? No sign-in; initials only. */
export default async function VerifyReport({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const v = await api<Verification>(`/api/diagnostics/v1/public/lab-reports/verify/${encodeURIComponent(code)}`).catch((e) => {
    if (e instanceof ApiError && e.status < 500) return { valid: false } as Verification;
    throw e;
  });
  const at = v.verifiedAt ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(v.verifiedAt)) : '';
  return (
    <ZoneFrame zone="patient" path="/care" zones={ZONES} requireAuth={false}>
      <PageHeader title="Verify a lab report" subtitle={`Code ${code.toUpperCase()}`} />
      {!v.valid ? <Alert tone="error">No report with this code was issued by this hospital. The document may not be genuine.</Alert> : (
        <>
          {v.current ? <Alert tone="success">Genuine report issued by {v.hospital}.</Alert>
            : <Alert tone="error">This report was issued by {v.hospital} but has since been corrected. Ask the patient for the latest version.</Alert>}
          <Card>
            <dl className="mc-dl">
              <dt>Report</dt><dd>{v.orderNo} · version {v.version}</dd>
              <dt>Patient</dt><dd>{v.patient}</dd>
              <dt>Verified by</dt><dd>{v.verifiedBy}, {at}</dd>
              <dt>Fingerprint (SHA-256)</dt><dd><code style={{ wordBreak: 'break-all' }}>{v.sha256}</code></dd>
            </dl>
          </Card>
        </>
      )}
    </ZoneFrame>
  );
}
