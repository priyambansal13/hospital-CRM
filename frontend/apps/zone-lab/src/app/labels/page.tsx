import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { zoneCapabilities } from '@mc/features';
import { age, barcodeSvg, type LabOrder } from '@/lib/lab';

export const dynamic = 'force-dynamic';

/** Printable tube labels for one order (name, MRN, age/sex, sample, barcode). */
export default async function Labels({ searchParams }: { searchParams: Promise<{ orderId?: string }> }) {
  await zoneCapabilities('lab', '/lab/labels');
  const { accessToken: token } = (await getSession())!;
  const { orderId } = await searchParams;
  const o = await api<LabOrder>(`/api/diagnostics/v1/lab-orders/${encodeURIComponent(orderId ?? '')}`, { token });
  return (
    <main style={{ padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <style>{'@media print { .no-print { display: none } } .label { width: 240px; border: 1px dashed #999; padding: 8px; margin: 8px; display: inline-block; font-size: 12px; page-break-inside: avoid }'}</style>
      <p className="no-print">Print with your browser (Ctrl/Cmd + P).</p>
      {o.samples.filter((s) => s.status === 'PENDING').map((s) => (
        <div key={s.id} className="label">
          <strong>{o.patient.name}</strong><br />
          {o.patient.mrn} · {age(o.patient.dob) ?? '?'} y{o.patient.gender ? ` ${o.patient.gender[0]}` : ''} · {o.localDate}<br />
          {s.sampleType} · {s.container ?? ''}
          <div dangerouslySetInnerHTML={{ __html: barcodeSvg(s.barcode) }} />
        </div>
      ))}
    </main>
  );
}
