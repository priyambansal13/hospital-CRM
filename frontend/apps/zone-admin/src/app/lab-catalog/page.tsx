import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Card, PageHeader, Table } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { savePackage, saveTest } from './actions';

export const dynamic = 'force-dynamic';

interface T { id: string; code: string; name: string; category: string; sampleType: string; preparation: string | null; turnaroundHours: number; price: number; active: boolean }
interface P { id: string; code: string; name: string; price: number; worth: number; active: boolean; tests: { name: string }[] }

/** The hospital's lab menu: prices, preparation shown to patients, on/off. */
export default async function LabCatalog({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await zoneCapabilities('admin', '/admin/lab-catalog');
  const { accessToken: token } = (await getSession())!;
  const cat = await api<{ tests: T[]; packages: P[] }>('/api/diagnostics/v1/admin/lab-catalog', { token });
  return (
    <ZoneFrame zone="admin" path="/admin/lab-catalog" zones={ZONES}>
      <PageHeader title="Lab catalog" subtitle="Prices and preparation patients see when booking. Switched-off items cannot be booked." />
      <Flash {...await searchParams} />
      <Card title="Packages">
        <Table rows={cat.packages} empty="No packages." columns={[
          { header: 'Package', cell: (p) => <>{p.name}<br /><span className="mc-meta">{p.tests.length} tests · worth ₹{p.worth}</span></> },
          { header: 'Price and availability', cell: (p) => (
            <form action={savePackage} className="mc-inline" aria-label={`Edit ${p.name}`}>
              <input type="hidden" name="id" value={p.id} /><input type="hidden" name="name" value={p.name} />
              <input name="price" type="number" min={0} step="1" defaultValue={p.price} aria-label={`Price of ${p.name}`} className="mc-input-sm" />
              <label className="mc-check"><input type="checkbox" name="active" defaultChecked={p.active} /> <span>on</span></label>
              <button className="mc-btn mc-btn-ghost">Save</button>
            </form>
          ) },
          { header: '', cell: (p) => (p.active ? <Badge tone="success">bookable</Badge> : <Badge>off</Badge>) },
        ]} />
      </Card>
      <Card title={`Tests (${cat.tests.length})`}>
        <Table rows={cat.tests} empty="No tests." columns={[
          { header: 'Test', cell: (t) => <>{t.name}<br /><span className="mc-meta">{t.code} · {t.category} · {t.sampleType.toLowerCase()} · ~{t.turnaroundHours} h</span></> },
          { header: 'Price, preparation, availability', cell: (t) => (
            <form action={saveTest} className="mc-inline" aria-label={`Edit ${t.name}`}>
              <input type="hidden" name="id" value={t.id} /><input type="hidden" name="name" value={t.name} />
              <input name="price" type="number" min={0} step="1" defaultValue={t.price} aria-label={`Price of ${t.name}`} className="mc-input-sm" style={{ width: 90 }} />
              <input name="preparation" defaultValue={t.preparation ?? ''} aria-label={`Preparation for ${t.name}`} placeholder="preparation" className="mc-input-sm" style={{ width: 240 }} />
              <label className="mc-check"><input type="checkbox" name="active" defaultChecked={t.active} /> <span>on</span></label>
              <button className="mc-btn mc-btn-ghost">Save</button>
            </form>
          ) },
        ]} />
      </Card>
    </ZoneFrame>
  );
}
