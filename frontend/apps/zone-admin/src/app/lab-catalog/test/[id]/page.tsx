import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Button, Card, Field, PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { saveTestDetails } from '../../detail-actions';

export const dynamic = 'force-dynamic';

interface Range { param: string; unit: string; sex?: 'M' | 'F'; low?: number; high?: number; criticalLow?: number; criticalHigh?: number }
interface Test { id: string; code: string; name: string; category: string; sampleType: string; turnaroundHours: number; fastingHours: number | null; referenceRanges: Range[] }

/** E-10: what a test's results are compared with (flags and critical alerts follow these), and how long it takes. */
export default async function TestDetails({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  await zoneCapabilities('admin', '/admin/lab-catalog');
  const { accessToken: token } = (await getSession())!;
  const t = (await api<{ tests: Test[] }>('/api/diagnostics/v1/admin/lab-catalog', { token })).tests.find((x) => x.id === id);
  if (!t) notFound();
  const rows: (Range | null)[] = [...t.referenceRanges, null, null, null];
  const v = (n: number | undefined) => (n == null ? undefined : String(n));
  return (
    <ZoneFrame zone="admin" path="/admin/lab-catalog" zones={ZONES}>
      <PageHeader title={t.name} subtitle={`${t.code} · ${t.category} · ${t.sampleType.toLowerCase()}`} actions={<a href="/admin/lab-catalog">Lab catalog</a>} />
      <Flash {...await searchParams} />
      <Card>
        <form action={saveTestDetails} className="mc-form">
          <input type="hidden" name="id" value={t.id} />
          <input type="hidden" name="rows" value={rows.length} />
          <Field label="Report within (hours)" name="turnaroundHours" inputMode="numeric" defaultValue={String(t.turnaroundHours)} required />
          <Field label="Fasting (hours, blank for none)" name="fastingHours" inputMode="numeric" defaultValue={v(t.fastingHours ?? undefined)} />
          <div className="mc-field-wide" style={{ overflowX: 'auto' }}>
            <table className="mc-table" aria-label="Reference ranges">
              <thead><tr><th>Parameter</th><th>Unit</th><th>Sex</th><th>Low</th><th>High</th><th>Critical below</th><th>Critical above</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td><input name={`param${i}`} defaultValue={r?.param} className="mc-input-sm" aria-label={`Parameter ${i + 1}`} /></td>
                    <td><input name={`unit${i}`} defaultValue={r?.unit} className="mc-input-sm" size={8} aria-label={`Unit ${i + 1}`} /></td>
                    <td><select name={`sex${i}`} defaultValue={r?.sex ?? ''} className="mc-select-sm" aria-label={`Sex ${i + 1}`}><option value="">All</option><option value="M">Male</option><option value="F">Female</option></select></td>
                    {(['low', 'high', 'criticalLow', 'criticalHigh'] as const).map((k) => (
                      <td key={k}><input name={`${k}${i}`} defaultValue={v(r?.[k])} inputMode="decimal" className="mc-input-sm" size={6} aria-label={`${k} ${i + 1}`} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <small className="mc-muted">A parameter with no limits is reported as text (colour, appearance). Leave a row's parameter empty to remove it. Critical limits raise an alert to the doctor and must lie outside low–high.</small>
          </div>
          <Button>Save</Button>
        </form>
      </Card>
    </ZoneFrame>
  );
}
